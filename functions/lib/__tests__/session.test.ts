import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockKV } from '../../../tests/helpers';
import { app } from '../../api/[[route]]';
import {
  getSessionContext,
  isSessionRevoked,
  persistSession,
  refreshSession,
  revokeSession,
  UPSTREAM_TIMEOUT_MS,
} from '../session';
import type { Env, SessionData } from '../types';

const ORIGIN = 'http://metacord.test';
const HOUR = 60 * 60 * 1000;

let env: Env;

const sessionFor = (userId: string): SessionData => ({
  userId,
  accessToken: `access-${userId}`,
  refreshToken: `refresh-${userId}`,
  expiresAt: Date.now() + HOUR,
  createdAt: Date.now(),
});

const requestWithCookie = (path: string, cookie: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { Cookie: cookie } });

beforeEach(() => {
  env = {
    DISCORD_CLIENT_ID: 'client',
    DISCORD_CLIENT_SECRET: 'secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/api/auth/callback`,
    SESSION_SECRET: 'test-session-secret',
    SESSIONS: createMockKV(),
  } as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSessionContext', () => {
  it('renews a live session', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const context = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(context.session?.userId).toBe('A');
    expect(context.setCookie).toContain('session=session-a');
  });

  it('refuses a revoked session without any Set-Cookie, even if its record was rewritten', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    await revokeSession('session-a', env);
    // A renewal that read the record before revocation rewrites it afterwards.
    await persistSession('session-a', sessionFor('A'), env);
    const put = vi.spyOn(env.SESSIONS, 'put');

    const context = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(context.session).toBeNull();
    expect(context.setCookie).toBeUndefined();
    // Refused before any rolling write, so the revoked record is not renewed even briefly.
    expect(put).not.toHaveBeenCalled();
  });

  it('does not leave a usable session when revocation lands between its read and its rolling write', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const kv = env.SESSIONS;
    const put = kv.put.bind(kv);
    let raced = false;
    vi.spyOn(kv, 'put').mockImplementation((async (key: string, value: string, options?: KVNamespacePutOptions) => {
      if (key === 'session-a' && !raced) {
        raced = true;
        await revokeSession('session-a', env); // B's sign-in, after this request read A's record
      }
      return put(key, value, options);
    }) as KVNamespace['put']);

    const racing = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(raced).toBe(true);
    expect(racing.session).toBeNull();
    expect(racing.setCookie).toBeUndefined();
    expect(await kv.get('session-a')).toBeNull();

    const later = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(later.session).toBeNull();
  });
});

describe('sign-in and logout', () => {
  const callback = (cookie: string) =>
    app.request(
      `${ORIGIN}/api/auth/callback?code=code&state=state`,
      { headers: { Cookie: `${cookie}oauth_state=state; oauth_verifier=verifier` } },
      env,
    );

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/token')) {
        return Response.json({ access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 3600 });
      }
      if (url.includes('/users/@me')) {
        return Response.json({ id: 'B', username: 'b' });
      }
      return new Response('unexpected', { status: 500 });
    });
  });

  const newSessionId = (response: Response): string | undefined =>
    response.headers
      .getSetCookie()
      .map((cookie) => /^session=([^;]+)/.exec(cookie)?.[1])
      .find((value): value is string => Boolean(value));

  it('revokes the session the browser already had, so it cannot switch the browser back', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const response = await callback('session=session-a; ');

    expect(response.status).toBe(302);
    expect(await env.SESSIONS.get('session-a')).toBeNull();
    expect(await isSessionRevoked('session-a', env)).toBe(true);
    const sessionB = newSessionId(response);
    expect(sessionB).toBeDefined();
    expect(sessionB).not.toBe('session-a');

    const reverted = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(reverted.session).toBeNull();
    expect(reverted.setCookie).toBeUndefined();
    const signedIn = await getSessionContext(requestWithCookie('/api/me', `session=${sessionB}`), env);
    expect(signedIn.session?.userId).toBe('B');
  });

  it('lets a late request with the old cookie fail without clearing a same-account re-login', async () => {
    await persistSession('session-a', sessionFor('B'), env);
    const relogin = await callback('session=session-a; ');
    const sessionB = newSessionId(relogin) as string;

    const late = await app.request(`${ORIGIN}/api/guilds`, { headers: { Cookie: 'session=session-a' } }, env);
    expect(late.status).toBe(401);
    expect(late.headers.getSetCookie()).toEqual([]);
    expect((await getSessionContext(requestWithCookie('/api/me', `session=${sessionB}`), env)).session?.userId).toBe(
      'B',
    );
  });

  it('keeps the previous session usable when storing the new one fails', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const kv = env.SESSIONS;
    const put = kv.put.bind(kv);
    vi.spyOn(kv, 'put').mockImplementation((async (key: string, value: string, options?: KVNamespacePutOptions) => {
      if (key !== 'session-a' && !key.startsWith('revoked:')) throw new Error('KV write failed');
      return put(key, value, options);
    }) as KVNamespace['put']);

    const response = await callback('session=session-a; ');
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(newSessionId(response)).toBeUndefined();
    expect(await isSessionRevoked('session-a', env)).toBe(false);
    expect((await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env)).session?.userId).toBe('A');
  });

  it('revokes the previous session only after the new one is stored', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const kv = env.SESSIONS;
    const writes: string[] = [];
    const put = kv.put.bind(kv);
    vi.spyOn(kv, 'put').mockImplementation((async (key: string, value: string, options?: KVNamespacePutOptions) => {
      writes.push(key);
      return put(key, value, options);
    }) as KVNamespace['put']);

    const sessionB = newSessionId(await callback('session=session-a; ')) as string;
    expect(writes).toEqual([sessionB, 'revoked:session-a']);
  });

  it('signs in normally without a previous session', async () => {
    const response = await callback('');
    expect(response.status).toBe(302);
    const sessionB = newSessionId(response) as string;
    expect((await env.SESSIONS.list({ prefix: 'revoked:' })).keys).toEqual([]);
    expect((await getSessionContext(requestWithCookie('/api/me', `session=${sessionB}`), env)).session?.userId).toBe(
      'B',
    );
  });

  it('logout revokes the session the same way', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    const response = await app.request(
      `${ORIGIN}/api/auth/logout`,
      { method: 'POST', headers: { Cookie: 'session=session-a' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await env.SESSIONS.get('session-a')).toBeNull();
    expect(await isSessionRevoked('session-a', env)).toBe(true);
    await persistSession('session-a', sessionFor('A'), env);
    expect((await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env)).session).toBeNull();
  });
});

describe('refusals never clear the cookie', () => {
  it('answers an unknown session with 401 and no Set-Cookie', async () => {
    const response = await app.request(`${ORIGIN}/api/guilds`, { headers: { Cookie: 'session=unknown' } }, env);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('ends a session whose token refresh fails, without clearing the cookie', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/oauth2/token') ? new Response('bad', { status: 400 }) : new Response('no', { status: 401 });
    });
    const response = await app.request(
      `${ORIGIN}/api/guilds`,
      { headers: { Cookie: 'session=session-a' } },
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await env.SESSIONS.get('session-a')).toBeNull();
  });
});

/** In-memory KV that honours expirationTtl against Date.now(), so fake clocks expire keys. */
function createExpiringKV(): KVNamespace {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) store.delete(key);
    return store.get(key) ?? null;
  };
  return {
    get: (async (key: string, type?: string) => {
      const entry = live(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    }) as KVNamespace['get'],
    put: (async (key: string, value: string, options?: KVNamespacePutOptions) => {
      const ttl = options?.expirationTtl;
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    }) as KVNamespace['put'],
    delete: (async (key: string) => {
      store.delete(key);
    }) as KVNamespace['delete'],
  } as KVNamespace;
}

/** Discord's token endpoint answering only after `delayMs`, unless the request is aborted. */
const slowTokenEndpoint = (delayMs: number) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })),
          delayMs,
        );
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      }),
  );

describe('revocation lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    env.SESSIONS = createExpiringKV();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a tombstone for a day', async () => {
    await revokeSession('session-a', env);
    await vi.advanceTimersByTimeAsync(23 * HOUR);
    expect(await isSessionRevoked('session-a', env)).toBe(true);
  });

  it('aborts a refresh that would finish after the tombstone expires, so logout sticks', async () => {
    // Close to expiry, so the next request refreshes the token.
    await persistSession('session-a', { ...sessionFor('A'), expiresAt: Date.now() + 60_000 }, env);
    slowTokenEndpoint(25 * HOUR);

    const pending = getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    await vi.advanceTimersByTimeAsync(1); // the request has read the record
    await revokeSession('session-a', env); // logout while the refresh is in flight
    await vi.advanceTimersByTimeAsync(25 * HOUR);
    const context = await pending;

    expect(context.session).toBeNull();
    expect(context.setCookie).toBeUndefined();
    expect(await env.SESSIONS.get('session-a')).toBeNull();
  });

  it('bounds each Discord call', async () => {
    slowTokenEndpoint(UPSTREAM_TIMEOUT_MS + 1);
    const refreshing = refreshSession('session-a', sessionFor('A'), env).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    expect(await refreshing).toBeInstanceOf(Error);
    expect(await env.SESSIONS.get('session-a')).toBeNull();
  });
});

describe('refreshSession', () => {
  it('does not restore a session revoked while the refresh was in flight', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    );
    await persistSession('session-a', sessionFor('A'), env);
    const kv = env.SESSIONS;
    const put = kv.put.bind(kv);
    let raced = false;
    vi.spyOn(kv, 'put').mockImplementation((async (key: string, value: string, options?: KVNamespacePutOptions) => {
      if (key === 'session-a' && !raced) {
        raced = true;
        await revokeSession('session-a', env);
      }
      return put(key, value, options);
    }) as KVNamespace['put']);

    expect(await refreshSession('session-a', sessionFor('A'), env)).toBeNull();
    expect(await kv.get('session-a')).toBeNull();
  });
});

describe('renewal cookies for sessions revoked mid-request', () => {
  it('drops the renewal when a sign-in revokes the session while the request waits on Discord', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    let releaseA: () => void = () => {};
    const aWaiting = new Promise<void>((resolve) => (releaseA = resolve));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/token')) {
        return Response.json({ access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 3600 });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === 'Bearer access-A') await aWaiting;
      return Response.json({ id: auth === 'Bearer access-A' ? 'A' : 'B', username: 'user', avatar: null });
    });

    const inFlight = app.request(`${ORIGIN}/api/me`, { headers: { Cookie: 'session=session-a' } }, env);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const signIn = await app.request(
      `${ORIGIN}/api/auth/callback?code=code&state=state`,
      { headers: { Cookie: 'session=session-a; oauth_state=state; oauth_verifier=verifier' } },
      env,
    );
    expect(signIn.headers.getSetCookie().some((cookie) => cookie.startsWith('session='))).toBe(true);
    releaseA();
    const late = await inFlight;

    expect(late.status).toBe(200);
    expect(late.headers.getSetCookie()).toEqual([]);
  });

  it('still renews live sessions', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ id: 'A', username: 'user', avatar: null }),
    );
    const response = await app.request(`${ORIGIN}/api/me`, { headers: { Cookie: 'session=session-a' } }, env);
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^session=session-a;/)]);
  });
});
