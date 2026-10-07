import { describe, it, expect } from 'vitest';
import {
  buildGuildListBody,
  buildGuildListCacheKey,
  GUILD_LIST_CACHE_VERSION,
  GUILDS_LIST_PATH,
  transformGuild,
} from '../guilds';
import { buildUserCacheKey } from '../cache';

describe('GUILDS_LIST_PATH', () => {
  it('requests approximate counts from Discord', () => {
    const url = new URL(`https://discord.com/api/v10${GUILDS_LIST_PATH}`);
    expect(url.pathname).toBe('/api/v10/users/@me/guilds');
    expect(url.searchParams.get('with_counts')).toBe('true');
  });
});

describe('transformGuild', () => {
  const base = {
    id: '123',
    name: 'Guild',
    icon: 'abc',
    banner: null,
    owner: true,
    features: ['COMMUNITY'],
  };

  it('includes approximate member and presence counts', () => {
    expect(transformGuild({ ...base, approximate_member_count: 1500, approximate_presence_count: 321 })).toEqual({
      ...base,
      approximate_member_count: 1500,
      approximate_presence_count: 321,
      icon_url: 'https://cdn.discordapp.com/icons/123/abc.png',
    });
  });

  it('returns null counts when Discord omits them', () => {
    const result = transformGuild(base);
    expect(result.approximate_member_count).toBeNull();
    expect(result.approximate_presence_count).toBeNull();
  });

  it('uses gif icon URLs for animated icons', () => {
    expect(transformGuild({ ...base, icon: 'a_xyz' }).icon_url).toBe('https://cdn.discordapp.com/icons/123/a_xyz.gif');
  });
});

describe('buildGuildListBody', () => {
  it('returns the session user id with the transformed guilds', () => {
    const guild = { id: '9', name: 'G', icon: null, banner: null, owner: false, features: [] };
    expect(buildGuildListBody('42', [guild])).toEqual({ user_id: '42', guilds: [transformGuild(guild)] });
  });
});

describe('buildGuildListCacheKey', () => {
  const request = new Request('https://metacord.example/api/guilds');

  it('is per user and versioned, so bodies cached before user_id existed are not served', () => {
    const key = new URL(buildGuildListCacheKey(request, '42').url);
    expect(key.searchParams.get('__cacheUser')).toBe('42');
    expect(key.searchParams.get('__guildListVersion')).toBe(GUILD_LIST_CACHE_VERSION);
    expect(key.toString()).not.toBe(buildUserCacheKey(request, '42').url);
    expect(buildGuildListCacheKey(request, '43').url).not.toBe(buildGuildListCacheKey(request, '42').url);
  });
});
