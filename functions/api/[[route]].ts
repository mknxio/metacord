import { Hono, type Context } from 'hono';
import {
  buildCacheKey,
  cachedJsonResponse,
  getCachedResponse,
} from '../lib/cache';
import { parseCookies, serializeCookie } from '../lib/cookies';
import {
  buildGuildListBody,
  buildGuildListCacheKey,
  buildGuildMemberBody,
  buildGuildMemberCacheKey,
  GUILDS_LIST_PATH,
} from '../lib/guilds';
import { createPkceChallenge, createPkceVerifier } from '../lib/crypto';
import { errorResponse, jsonResponse } from '../lib/http';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  deleteSession,
  getSessionCookieName,
  getSessionContext,
  isSecureContext,
  persistSession,
  refreshSession,
  revokeSession,
} from '../lib/session';
import {
  DiscordGuild,
  DiscordMember,
  DiscordTokenResponse,
  DiscordUser,
  Env,
  SessionData,
} from '../lib/types';

const app = new Hono<{ Bindings: Env }>();

const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const SCOPES = ['identify', 'guilds', 'guilds.members.read'];

const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_VERIFIER_COOKIE = 'oauth_verifier';
const OAUTH_COOKIE_MAX_AGE = 600;

function getOAuthCookieName(baseName: string, secure: boolean): string {
  return secure ? `__Host-${baseName}` : baseName;
}

app.get('/api/health', () => jsonResponse({ ok: true }));

app.get('/api/auth/login', async (c) => {
  const state = crypto.randomUUID();
  const verifier = createPkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  const secure = isSecureContext(c.req.raw);

  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: c.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const headers = new Headers();
  headers.set('Location', `${DISCORD_OAUTH_URL}?${params.toString()}`);
  headers.append('Set-Cookie', buildOAuthCookie(getOAuthCookieName(OAUTH_STATE_COOKIE, secure), state, secure));
  headers.append('Set-Cookie', buildOAuthCookie(getOAuthCookieName(OAUTH_VERIFIER_COOKIE, secure), verifier, secure));

  return new Response(null, { status: 302, headers });
});

app.get('/api/auth/callback', async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return errorResponse(`Discord OAuth error: ${error}`, 400);
  }

  if (!code || !state) {
    return errorResponse('Missing code or state parameter', 400);
  }

  const cookies = parseCookies(c.req.header('Cookie') ?? null);
  const secure = isSecureContext(c.req.raw);
  const savedState = cookies[getOAuthCookieName(OAUTH_STATE_COOKIE, secure)];
  const verifier = cookies[getOAuthCookieName(OAUTH_VERIFIER_COOKIE, secure)];

  if (!savedState || !verifier || savedState !== state) {
    return errorResponse('Invalid state parameter', 400);
  }

  const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: c.env.DISCORD_CLIENT_ID,
      client_secret: c.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: c.env.DISCORD_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    return errorResponse('Failed to exchange authorization code', 500);
  }

  const tokenData: DiscordTokenResponse = await tokenResponse.json();
  if (!tokenData.refresh_token) {
    return errorResponse('Discord did not return a refresh token', 500);
  }
  const userResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  if (!userResponse.ok) {
    return errorResponse('Failed to fetch user info', 500);
  }

  const user: DiscordUser = await userResponse.json();

  // This sign-in replaces any session the browser already had (possibly another account's).
  // Revoke it so a delayed response renewing the old cookie cannot switch the browser back.
  const previousSessionId = cookies[getSessionCookieName(secure)];
  if (previousSessionId) {
    await revokeSession(previousSessionId, c.env);
  }

  const sessionId = crypto.randomUUID();
  const now = Date.now();

  await persistSession(
    sessionId,
    {
      userId: user.id,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: now + tokenData.expires_in * 1000,
      createdAt: now,
    },
    c.env
  );

  const headers = new Headers();
  headers.set('Location', '/');
  headers.append('Set-Cookie', buildSessionCookie(sessionId, secure));
  headers.append('Set-Cookie', clearOAuthCookie(getOAuthCookieName(OAUTH_STATE_COOKIE, secure), secure));
  headers.append('Set-Cookie', clearOAuthCookie(getOAuthCookieName(OAUTH_VERIFIER_COOKIE, secure), secure));

  return new Response(null, { status: 302, headers });
});

type AppContext = Context<{ Bindings: Env }>;

const logoutHandler = async (c: AppContext) => {
  const secure = isSecureContext(c.req.raw);
  const cookies = parseCookies(c.req.header('Cookie') ?? null);
  const sessionId = cookies[getSessionCookieName(secure)];
  if (sessionId) {
    await revokeSession(sessionId, c.env);
  }

  const headers = new Headers();
  headers.append('Set-Cookie', buildClearSessionCookie(secure));

  if (c.req.method === 'GET') {
    headers.set('Location', '/');
    return new Response(null, { status: 302, headers });
  }

  return jsonResponse({ success: true }, 200, headers);
};

app.get('/api/auth/logout', logoutHandler);
app.post('/api/auth/logout', logoutHandler);

app.get('/api/me', async (c) => {
  const sessionContext = await getSessionContext(c.req.raw, c.env);
  const headers = new Headers();
  applySessionHeaders(headers, sessionContext);

  if (!sessionContext.session || !sessionContext.sessionId) {
    return jsonResponse({ authenticated: false }, 200, headers);
  }

  const result = await fetchDiscordWithRefresh(
    `${DISCORD_API_BASE}/users/@me`,
    sessionContext,
    c.env
  );

  // No clearing cookie on refusal (see SessionContext): the session is deleted server-side.
  if (!result.session || result.response.status === 401) {
    return jsonResponse({ authenticated: false, reason: 'invalid_token' }, 200);
  }

  if (!result.response.ok) {
    return errorResponse('Failed to fetch user info', 500, headers);
  }

  const user: DiscordUser = await result.response.json();

  return jsonResponse(
    {
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        global_name: user.global_name,
        avatar: user.avatar,
        avatar_url: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : null,
      },
    },
    200,
    headers
  );
});

app.get('/api/guilds', async (c) => {
  const sessionContext = await getSessionContext(c.req.raw, c.env);
  if (!sessionContext.session || !sessionContext.sessionId) {
    const headers = new Headers();
    applySessionHeaders(headers, sessionContext);
    return errorResponse('Unauthorized', 401, headers);
  }

  const cacheKey = buildGuildListCacheKey(c.req.raw, sessionContext.session.userId);
  const cached = await getCachedResponse(cacheKey, sessionContext.setCookie);
  if (cached) return cached;

  const result = await fetchDiscordWithRefresh(
    `${DISCORD_API_BASE}${GUILDS_LIST_PATH}`,
    sessionContext,
    c.env
  );

  // No clearing cookie on refusal (see SessionContext): the session is deleted server-side.
  if (!result.session || result.response.status === 401) {
    return errorResponse('Unauthorized', 401);
  }

  if (!result.response.ok) {
    return errorResponse('Failed to fetch guilds', 500);
  }

  const guilds: DiscordGuild[] = await result.response.json();

  return cachedJsonResponse(
    c.executionCtx,
    cacheKey,
    buildGuildListBody(sessionContext.session.userId, guilds),
    {
      ttlSeconds: 600,
      swrSeconds: 300,
      visibility: 'private',
      sessionCookie: sessionContext.setCookie,
    }
  );
});

app.get('/api/guilds/:id', async (c) => {
  const sessionContext = await getSessionContext(c.req.raw, c.env);
  if (!sessionContext.session || !sessionContext.sessionId) {
    const headers = new Headers();
    applySessionHeaders(headers, sessionContext);
    return errorResponse('Unauthorized', 401, headers);
  }

  const guildId = c.req.param('id');
  if (!isValidGuildId(guildId)) {
    return errorResponse('Invalid guild ID format', 400);
  }

  const cacheKey = buildGuildMemberCacheKey(c.req.raw, sessionContext.session.userId);
  const cached = await getCachedResponse(cacheKey, sessionContext.setCookie);
  if (cached) return cached;

  const result = await fetchDiscordWithRefresh(
    `${DISCORD_API_BASE}/users/@me/guilds/${guildId}/member`,
    sessionContext,
    c.env
  );

  // No clearing cookie on refusal (see SessionContext): the session is deleted server-side.
  if (!result.session || result.response.status === 401) {
    return errorResponse('Unauthorized', 401);
  }

  if (!result.response.ok) {
    if (result.response.status === 404) {
      return errorResponse('Not a member of this guild', 404);
    }
    return errorResponse('Failed to fetch member info', 500);
  }

  const member: DiscordMember = await result.response.json();

  return cachedJsonResponse(
    c.executionCtx,
    cacheKey,
    buildGuildMemberBody(sessionContext.session.userId, guildId, member),
    {
      ttlSeconds: 45,
      swrSeconds: 60,
      visibility: 'private',
      sessionCookie: sessionContext.setCookie,
    }
  );
});

app.get('/api/widget/:id', async (c) => {
  const guildId = c.req.param('id');
  if (!isValidGuildId(guildId)) {
    return errorResponse('Invalid guild ID format', 400);
  }

  const cacheKey = buildCacheKey(c.req.raw);
  const cached = await getCachedResponse(cacheKey);
  if (cached) return cached;

  // Get the rate limiter DO stub (use a single instance for widget endpoint)
  const rateLimiterId = c.env.DISCORD_RATE_LIMITER.idFromName('widget');
  const rateLimiter = c.env.DISCORD_RATE_LIMITER.get(rateLimiterId);

  // Acquire a rate limit slot
  const slot = await rateLimiter.acquireSlot();
  if (!slot.allowed) {
    return c.json(
      { error: slot.error || 'Rate limited', retryAfter: slot.waitMs ? Math.ceil(slot.waitMs / 1000) : null },
      { status: 429, headers: slot.waitMs ? { 'Retry-After': String(Math.ceil(slot.waitMs / 1000)) } : {} }
    );
  }

  try {
    const widgetResponse = await fetch(
      `${DISCORD_API_BASE}/guilds/${guildId}/widget.json`
    );

    // Extract rate limit headers and update DO state
    const rateLimitHeaders: Record<string, string | null> = {
      'x-ratelimit-limit': widgetResponse.headers.get('x-ratelimit-limit'),
      'x-ratelimit-remaining': widgetResponse.headers.get('x-ratelimit-remaining'),
      'x-ratelimit-reset': widgetResponse.headers.get('x-ratelimit-reset'),
      'x-ratelimit-reset-after': widgetResponse.headers.get('x-ratelimit-reset-after'),
      'x-ratelimit-bucket': widgetResponse.headers.get('x-ratelimit-bucket'),
      'x-ratelimit-global': widgetResponse.headers.get('x-ratelimit-global'),
      'x-ratelimit-scope': widgetResponse.headers.get('x-ratelimit-scope'),
    };
    await rateLimiter.updateFromResponse(rateLimitHeaders);

    if (!widgetResponse.ok) {
      if (widgetResponse.status === 403 || widgetResponse.status === 404) {
        return cachedJsonResponse(
          c.executionCtx,
          cacheKey,
          { enabled: false, guild_id: guildId },
          { ttlSeconds: 60, swrSeconds: 120, visibility: 'public' }
        );
      }
      if (widgetResponse.status === 429) {
        const retryAfterHeader = widgetResponse.headers.get('Retry-After');
        let retryAfter: number | null = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;

        // Also check JSON body for retry_after if header not present
        if (retryAfter === null) {
          try {
            const body = await widgetResponse.json() as { retry_after?: number };
            if (body.retry_after) {
              retryAfter = Math.ceil(body.retry_after);
            }
          } catch {
            // Ignore JSON parse errors
          }
        }

        // Notify rate limiter about the 429
        if (retryAfter !== null) {
          await rateLimiter.handleRateLimited(retryAfter);
        }

        return c.json(
          { error: 'Rate limited', retryAfter },
          { status: 429, headers: retryAfter ? { 'Retry-After': String(retryAfter) } : {} }
        );
      }
      return errorResponse('Failed to fetch widget', 500);
    }

    const widget = await widgetResponse.json() as {
      name: string;
      instant_invite: string | null;
      presence_count: number;
      channels: Array<{ id: string; name: string; position: number }>;
    };
    return cachedJsonResponse(
      c.executionCtx,
      cacheKey,
      {
        enabled: true,
        guild_id: guildId,
        name: widget.name,
        instant_invite: widget.instant_invite,
        presence_count: widget.presence_count,
        channels: widget.channels,
      },
      { ttlSeconds: 60, swrSeconds: 120, visibility: 'public' }
    );
  } finally {
    // Always release the slot when done
    await rateLimiter.releaseSlot();
  }
});

export const onRequest = app.fetch;
export { app };

function buildOAuthCookie(name: string, value: string, secure: boolean = true): string {
  return serializeCookie(name, value, {
    path: '/',
    httpOnly: true,
    secure: secure,
    sameSite: 'Lax',
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
}

function clearOAuthCookie(name: string, secure: boolean = true): string {
  return serializeCookie(name, '', {
    path: '/',
    httpOnly: true,
    secure: secure,
    sameSite: 'Lax',
    maxAge: 0,
  });
}

function applySessionHeaders(headers: Headers, sessionContext: Awaited<ReturnType<typeof getSessionContext>>): void {
  if (sessionContext.setCookie) {
    headers.append('Set-Cookie', sessionContext.setCookie);
  }
}

async function fetchDiscordWithRefresh(
  url: string,
  sessionContext: Awaited<ReturnType<typeof getSessionContext>>,
  env: Env
): Promise<{ response: Response; session: SessionData | null }> {
  if (!sessionContext.session || !sessionContext.sessionId) {
    return { response: new Response(null, { status: 401 }), session: null };
  }

  let response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${sessionContext.session.accessToken}`,
    },
  });

  if (response.status !== 401) {
    return { response, session: sessionContext.session };
  }

  const refreshed = await refreshSession(
    sessionContext.sessionId,
    sessionContext.session,
    env
  );

  if (!refreshed) {
    // The session can no longer reach Discord: end it here instead of clearing the cookie.
    await deleteSession(sessionContext.sessionId, env);
    return { response, session: null };
  }

  response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${refreshed.accessToken}`,
    },
  });

  return { response, session: refreshed };
}

function isValidGuildId(guildId: string | undefined): boolean {
  if (!guildId) return false;
  return /^\d{17,20}$/.test(guildId);
}
