import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockKV } from '../../../tests/helpers';
import { app } from '../../api/[[route]]';
import { getSessionContext, isSessionRevoked, persistSession, revokeSession } from '../session';
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

  it('refuses a revoked session: no renewal, a clear cookie, even if its record was rewritten', async () => {
    await persistSession('session-a', sessionFor('A'), env);
    await revokeSession('session-a', env);
    // A renewal that read the record before revocation rewrites it afterwards.
    await persistSession('session-a', sessionFor('A'), env);
    const put = vi.spyOn(env.SESSIONS, 'put');

    const context = await getSessionContext(requestWithCookie('/api/me', 'session=session-a'), env);
    expect(context.session).toBeNull();
    expect(context.setCookie).toBeUndefined();
    expect(context.clearCookie).toContain('Max-Age=0');
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
    expect(reverted.clearCookie).toBeDefined();
    const signedIn = await getSessionContext(requestWithCookie('/api/me', `session=${sessionB}`), env);
    expect(signedIn.session?.userId).toBe('B');
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
