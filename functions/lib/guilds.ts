import { buildUserCacheKey } from './cache';
import type { DiscordGuild } from './types';

/** Guild-list path; `with_counts=true` adds approximate member and presence counts. */
export const GUILDS_LIST_PATH = '/users/@me/guilds?with_counts=true';

export interface TransformedGuild {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  owner: boolean;
  features: string[];
  approximate_member_count: number | null;
  approximate_presence_count: number | null;
  icon_url: string | null;
}

const toCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function transformGuild(guild: DiscordGuild): TransformedGuild {
  return {
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    banner: guild.banner,
    owner: guild.owner,
    features: guild.features,
    approximate_member_count: toCount(guild.approximate_member_count),
    approximate_presence_count: toCount(guild.approximate_presence_count),
    icon_url: guild.icon
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith('a_') ? 'gif' : 'png'}`
      : null,
  };
}

export interface GuildListBody {
  /** The session's Discord user ID, so the client never applies this list to another account's data. */
  user_id: string;
  guilds: TransformedGuild[];
}

export function buildGuildListBody(userId: string, guilds: DiscordGuild[]): GuildListBody {
  return { user_id: userId, guilds: guilds.map(transformGuild) };
}

/**
 * Bump when the cached /api/guilds body changes shape, so edge-cached bodies of the old shape
 * (for example without `user_id`, which the client refuses) are never served.
 */
export const GUILD_LIST_CACHE_VERSION = '2';

export function buildGuildListCacheKey(request: Request, userId: string): Request {
  const url = new URL(buildUserCacheKey(request, userId).url);
  url.searchParams.set('__guildListVersion', GUILD_LIST_CACHE_VERSION);
  return new Request(url.toString(), { method: 'GET' });
}
