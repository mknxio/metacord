import type { DiscordGuild, DiscordUser, WidgetData } from '../../shared/types';

/** User info returned by the /api/me endpoint */
export type ApiUser = Pick<DiscordUser, 'id' | 'username' | 'avatar'>;

/** Guild object returned by the /api/guilds endpoint */
export type ApiGuild = DiscordGuild;

/** Member info returned by the /api/guilds/:id endpoint */
export interface ApiGuildMember {
  guild_id: string;
  joined_at?: string | null;
  roles?: string[];
  nickname?: string | null;
  avatar?: string | null;
}

/** Public widget data for a guild; both fields are null when the widget is disabled */
export type ApiWidget = WidgetData;

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
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
  guilds: ApiGuild[];
}

export async function fetchMe(): Promise<ApiUser> {
  const response = await apiRequest<MeResponse>('/api/me');
  if (!response.authenticated || !response.user) {
    throw new AuthError(response.reason ?? 'Not authenticated');
  }
  return response.user;
}

export async function fetchGuilds(): Promise<ApiGuild[]> {
  const response = await apiRequest<GuildsResponse>('/api/guilds');
  return response.guilds;
}

export function fetchGuildMember(guildId: string): Promise<ApiGuildMember> {
  return apiRequest<ApiGuildMember>(`/api/guilds/${guildId}`);
}

const DISCORD_WIDGET_BASE = 'https://discord.com/api/v10/guilds';
const GUILD_ID_PATTERN = /^\d{17,20}$/;
const DISABLED_WIDGET: ApiWidget = { instant_invite: null, presence_count: null };

interface DiscordWidgetResponse {
  instant_invite?: unknown;
  presence_count?: unknown;
}

const parseRetryAfter = async (response: Response): Promise<number | null> => {
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after) && body.retry_after >= 0) {
      return Math.ceil(body.retry_after);
    }
  } catch {
    // Fall back to the header when the body is missing or not JSON.
  }
  // Retry-After may not be CORS-exposed, so it is only a fallback.
  const header = response.headers.get('Retry-After');
  const seconds = header ? Number.parseInt(header, 10) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

/**
 * Fetch a guild's public widget directly from Discord.
 *
 * The widget endpoint is public and credential-free, and Discord limits unauthenticated
 * requests per client IP, so calling it from the browser keeps each user on their own
 * limits instead of sharing the Worker's egress IP. The request carries no credentials
 * and no non-safelisted headers, so it never triggers a CORS preflight.
 */
export async function fetchWidget(guildId: string): Promise<ApiWidget> {
  if (!GUILD_ID_PATTERN.test(guildId)) {
    throw new Error('Invalid guild ID format');
  }

  const response = await fetch(`${DISCORD_WIDGET_BASE}/${guildId}/widget.json`, {
    method: 'GET',
    credentials: 'omit',
  });

  // Discord returns 403 for a disabled widget and 404 for an unknown guild.
  if (response.status === 403 || response.status === 404) {
    return { ...DISABLED_WIDGET };
  }

  if (response.status === 429) {
    throw new RateLimitError(await parseRetryAfter(response));
  }

  if (!response.ok) {
    throw new Error(`Widget request failed: ${response.status}`);
  }

  const widget = (await response.json()) as DiscordWidgetResponse;
  return {
    instant_invite: typeof widget.instant_invite === 'string' ? widget.instant_invite : null,
    presence_count: typeof widget.presence_count === 'number' ? widget.presence_count : null,
  };
}

export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST' });
}
