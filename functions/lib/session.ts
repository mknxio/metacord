import { serializeCookie, parseCookies } from './cookies';
import { decryptToken, encryptToken } from './crypto';
import { DiscordTokenResponse, Env, SessionData, SessionRecord } from './types';

const SESSION_COOKIE_NAME_SECURE = '__Host-session';
const SESSION_COOKIE_NAME_INSECURE = 'session';
const SESSION_TTL_SECONDS = 60 * 30;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
/**
 * Each Discord call made while handling a session is aborted after this long, so a request
 * that read a session record can only write it back within a bounded time: at most a few
 * such calls (refresh, upstream request, refresh, retry) plus KV operations, about a minute.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Revocation tombstones must outlive any request that read the record before revocation and
 * could rewrite it afterwards. Requests are bounded by UPSTREAM_TIMEOUT_MS to about a minute;
 * a day leaves an ample margin (and covers the 30-minute rolling session several times over).
 */
const REVOKED_TTL_SECONDS = 24 * 60 * 60;

const revokedKey = (sessionId: string): string => `revoked:${sessionId}`;

/**
 * A refused session never comes with a clearing Set-Cookie: the response may arrive after the
 * browser already holds a newer cookie (a re-login, or another account), and clearing would
 * sign that newer session out. A dead cookie only yields 401s until it expires.
 */
export interface SessionContext {
  sessionId: string | null;
  session: SessionData | null;
  setCookie?: string;
  secure: boolean;
}

/**
 * Determines if the request is coming from a secure context (HTTPS).
 * Used to decide whether to use __Host- prefixed cookies with secure flag.
 */
export function isSecureContext(request?: Request): boolean {
  if (!request) return true;
  const url = new URL(request.url);
  return url.protocol === 'https:';
}

export function getSessionCookieName(secure: boolean = true): string {
  return secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME_INSECURE;
}

export function buildSessionCookie(sessionId: string, secure: boolean = true): string {
  return serializeCookie(getSessionCookieName(secure), sessionId, {
    path: '/',
    httpOnly: true,
    secure: secure,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function buildClearSessionCookie(secure: boolean = true): string {
  return serializeCookie(getSessionCookieName(secure), '', {
    path: '/',
    httpOnly: true,
    secure: secure,
    sameSite: 'Lax',
    maxAge: 0,
  });
}

/** fetch with UPSTREAM_TIMEOUT_MS: rejects (and aborts the request) when Discord is too slow. */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Discord request timed out after ${UPSTREAM_TIMEOUT_MS} ms`)),
    UPSTREAM_TIMEOUT_MS,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getSessionContext(request: Request, env: Env): Promise<SessionContext> {
  const secure = isSecureContext(request);
  const cookieName = getSessionCookieName(secure);
  const cookies = parseCookies(request.headers.get('Cookie'));
  const sessionId = cookies[cookieName];
  if (!sessionId) {
    return { sessionId: null, session: null, secure };
  }

  const [record, revoked] = await Promise.all([
    env.SESSIONS.get<SessionRecord>(sessionId, 'json'),
    isSessionRevoked(sessionId, env),
  ]);
  if (!record || revoked) {
    // A revoked session stays dead even if a racing renewal rewrote its record.
    return { sessionId, session: null, secure };
  }

  try {
    const accessToken = await decryptToken(record.access_token, env.SESSION_SECRET);
    const refreshToken = await decryptToken(record.refresh_token, env.SESSION_SECRET);
    let session: SessionData = {
      userId: record.user_id,
      accessToken,
      refreshToken,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    };

    if (session.expiresAt - Date.now() <= REFRESH_WINDOW_MS) {
      const refreshed = await refreshSession(sessionId, session, env);
      if (!refreshed) {
        await deleteSession(sessionId, env);
        return { sessionId, session: null, secure };
      }
      session = refreshed;
    } else {
      await persistSession(sessionId, session, env);
    }

    // The rolling write above may have landed after a revocation that happened once the
    // record was read (for example a sign-in as another account): undo it and do not renew.
    if (await isSessionRevoked(sessionId, env)) {
      await deleteSession(sessionId, env);
      return { sessionId, session: null, secure };
    }

    return {
      sessionId,
      session,
      setCookie: buildSessionCookie(sessionId, secure),
      secure,
    };
  } catch {
    await deleteSession(sessionId, env);
    return { sessionId, session: null, secure };
  }
}

export async function persistSession(
  sessionId: string,
  session: SessionData,
  env: Env
): Promise<void> {
  const record: SessionRecord = {
    user_id: session.userId,
    access_token: await encryptToken(session.accessToken, env.SESSION_SECRET),
    refresh_token: await encryptToken(session.refreshToken, env.SESSION_SECRET),
    expires_at: session.expiresAt,
    created_at: session.createdAt,
  };
  await env.SESSIONS.put(sessionId, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function deleteSession(sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.delete(sessionId);
}

export async function isSessionRevoked(sessionId: string, env: Env): Promise<boolean> {
  return (await env.SESSIONS.get(revokedKey(sessionId))) !== null;
}

/**
 * Drops renewal Set-Cookie headers for sessions revoked while the request was running. A
 * request can pass getSessionContext, then wait on Discord while another tab's sign-in
 * revokes its session; renewing that cookie would overwrite the newer one and sign the
 * browser out. Checked as the response leaves, so it covers every route that renews.
 */
export async function withoutRevokedSessionCookies(
  response: Response,
  request: Request,
  env: Env
): Promise<Response> {
  const prefix = `${getSessionCookieName(isSecureContext(request))}=`;
  const cookies = response.headers.getSetCookie();
  const kept: string[] = [];
  for (const cookie of cookies) {
    const sessionId = cookie.startsWith(prefix) ? cookie.slice(prefix.length).split(';')[0] : '';
    if (sessionId && (await isSessionRevoked(sessionId, env))) continue;
    kept.push(cookie);
  }
  if (kept.length === cookies.length) return response;
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie');
  for (const cookie of kept) headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Ends a session for good (logout, or a sign-in that replaces it): writes a tombstone, then
 * deletes the record and its encrypted tokens. getSessionContext refuses tombstoned sessions
 * and re-checks after its rolling write, so a request still in flight with the old cookie
 * cannot renew it or set that cookie again on a later request.
 *
 * Limit: Workers KV is eventually consistent across locations (a write can take up to about
 * 60 seconds to be visible elsewhere), so a request served by another location within that
 * window may still read the old record and miss the tombstone. Revocation is reliable within
 * a location and converges everywhere after propagation; it is not instantaneous globally.
 */
export async function revokeSession(sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.put(revokedKey(sessionId), '1', { expirationTtl: REVOKED_TTL_SECONDS });
  await deleteSession(sessionId, env);
}

export async function refreshSession(
  sessionId: string,
  session: SessionData,
  env: Env
): Promise<SessionData | null> {
  if (!session.refreshToken) {
    return null;
  }
  const response = await fetchWithTimeout(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const tokenData: DiscordTokenResponse = await response.json();
  const now = Date.now();
  const refreshed: SessionData = {
    userId: session.userId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? session.refreshToken,
    expiresAt: now + tokenData.expires_in * 1000,
    createdAt: session.createdAt,
  };

  await persistSession(sessionId, refreshed, env);
  // As in getSessionContext: a revocation that landed during the refresh wins over this write.
  if (await isSessionRevoked(sessionId, env)) {
    await deleteSession(sessionId, env);
    return null;
  }
  return refreshed;
}
