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
