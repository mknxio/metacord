import { describe, it, expect } from 'vitest';
import { GUILDS_LIST_PATH, transformGuild } from '../guilds';

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
