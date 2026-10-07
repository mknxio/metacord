import type { DiscordGuild, DiscordUser, WidgetData } from '../../shared/types';

/** User info returned by the /api/me endpoint */
export type ApiUser = Pick<DiscordUser, 'id' | 'username' | 'avatar'>;

/** Guild object returned by the /api/guilds endpoint */
export type ApiGuild = DiscordGuild;

/** Member info returned by the /api/guilds/:id endpoint */
export interface ApiGuildMember {
  /** The session's Discord user ID (see fetchGuildMember). */
  user_id?: string;
  guild_id: string;
  joined_at?: string | null;
  roles?: string[];
  nickname?: string | null;
  avatar?: string | null;
}

/** Widget data returned by the /api/widget/:id endpoint */
export type ApiWidget = WidgetData;

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

/** The session belongs to a different Discord account than the data this page has loaded. */
export class AccountMismatchError extends Error {
  expected: string;
  actual: string | null;
  constructor(expected: string, actual: string | null) {
    super('The signed-in Discord account changed');
    this.name = 'AccountMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class RateLimitError extends Error {
  retryAfter: number | null;
  constructor(retryAfter: number | null = null) {
    super('Rate limited');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

const DEFAULT_HEADERS: HeadersInit = {
  Accept: 'application/json',
};

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...DEFAULT_HEADERS,
      ...options.headers,
    },
    credentials: 'include',
  });

  if (response.status === 401) {
    throw new AuthError();
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : null);
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

interface MeResponse {
  authenticated: boolean;
  user?: ApiUser;
  reason?: string;
}

interface GuildsResponse {
  user_id?: unknown;
  guilds: ApiGuild[];
}

export async function fetchMe(): Promise<ApiUser> {
  const response = await apiRequest<MeResponse>('/api/me');
  if (!response.authenticated || !response.user) {
    throw new AuthError(response.reason ?? 'Not authenticated');
  }
  return response.user;
}

/**
 * Loads the session's guild list and refuses it (AccountMismatchError) unless it belongs to
 * `accountId`, the account whose data is loaded. The session cookie is shared across tabs, so
 * another tab may have signed in as someone else. A missing `user_id` is refused too.
 *
 * Account-scoped responses bypass the browser HTTP cache (`no-cache` revalidates with the
 * server, whose edge cache is keyed per user): the browser cache is keyed by URL only and
 * would otherwise hand one account's response to another account in the same browser.
 */
export async function fetchGuilds(accountId: string): Promise<ApiGuild[]> {
  const response = await apiRequest<GuildsResponse>('/api/guilds', { cache: 'no-cache' });
  const userId = typeof response.user_id === 'string' ? response.user_id : null;
  if (userId !== accountId) {
    throw new AccountMismatchError(accountId, userId);
  }
  return response.guilds;
}

/**
 * Loads the session's membership in a guild and refuses it (AccountMismatchError) unless it
 * was issued for `accountId`: the shared session cookie may already belong to an account
 * another tab signed in as, before that tab announces the switch.
 */
export async function fetchGuildMember(guildId: string, accountId: string): Promise<ApiGuildMember> {
  const member = await apiRequest<ApiGuildMember>(`/api/guilds/${guildId}`, { cache: 'no-cache' });
  const userId = typeof member.user_id === 'string' ? member.user_id : null;
  if (userId !== accountId) {
    throw new AccountMismatchError(accountId, userId);
  }
  return member;
}

export function fetchWidget(guildId: string): Promise<ApiWidget> {
  return apiRequest<ApiWidget>(`/api/widget/${guildId}`);
}

export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST' });
}
