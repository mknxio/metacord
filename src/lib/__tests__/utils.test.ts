import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatNumber,
  getIconUrl,
  getBannerUrl,
  createElement,
  formatRelativeTime,
  getCooldownRemaining,
  formatCooldownRemaining,
  formatSecondsRemaining,
  normalizeInviteUrl,
} from '../utils';

describe('formatNumber', () => {
  it('returns "0" for zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('returns the number as-is below 1000', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(999)).toBe('999');
  });

  it('returns rounded thousands with K suffix at 1000', () => {
    expect(formatNumber(1000)).toBe('1K');
  });

  it('rounds to nearest thousand for values between 1000 and 999999', () => {
    expect(formatNumber(1500)).toBe('2K');
    expect(formatNumber(1499)).toBe('1K');
    expect(formatNumber(999999)).toBe('1000K');
    expect(formatNumber(50000)).toBe('50K');
  });

  it('returns millions with one decimal for values >= 1000000', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
    expect(formatNumber(1500000)).toBe('1.5M');
    expect(formatNumber(10000000)).toBe('10.0M');
    expect(formatNumber(1234567)).toBe('1.2M');
  });
});

describe('getIconUrl', () => {
  const guildId = '123456789';

  it('returns null when iconHash is null', () => {
    expect(getIconUrl(guildId, null)).toBeNull();
  });

  it('returns null when iconHash is undefined', () => {
    expect(getIconUrl(guildId, undefined)).toBeNull();
  });

  it('returns null when iconHash is empty string', () => {
    expect(getIconUrl(guildId, '')).toBeNull();
  });

  it('returns png URL for static icon', () => {
    const hash = 'abc123';
    expect(getIconUrl(guildId, hash)).toBe(
      `https://cdn.discordapp.com/icons/${guildId}/${hash}.png`,
    );
  });

  it('returns gif URL for animated icon (a_ prefix)', () => {
    const hash = 'a_abc123';
    expect(getIconUrl(guildId, hash)).toBe(
      `https://cdn.discordapp.com/icons/${guildId}/${hash}.gif`,
    );
  });
});

describe('getBannerUrl', () => {
  const guildId = '123456789';

  it('returns null when bannerHash is null', () => {
    expect(getBannerUrl(guildId, null)).toBeNull();
  });

  it('returns null when bannerHash is undefined', () => {
    expect(getBannerUrl(guildId, undefined)).toBeNull();
  });

  it('returns null when bannerHash is empty string', () => {
    expect(getBannerUrl(guildId, '')).toBeNull();
  });

  it('returns png URL with size=480 for valid banner hash', () => {
    const hash = 'banner123';
    expect(getBannerUrl(guildId, hash)).toBe(
      `https://cdn.discordapp.com/banners/${guildId}/${hash}.png?size=480`,
    );
  });

  it('does not use gif for animated banner hashes (always png)', () => {
    const hash = 'a_banner123';
    expect(getBannerUrl(guildId, hash)).toBe(
      `https://cdn.discordapp.com/banners/${guildId}/${hash}.png?size=480`,
    );
  });
});

describe('createElement', () => {
  it('creates an element of the specified tag', () => {
    const el = createElement('div');
    expect(el.tagName).toBe('DIV');
  });

  it('creates a span element', () => {
    const el = createElement('span');
    expect(el.tagName).toBe('SPAN');
  });

  it('sets className when provided', () => {
    const el = createElement('div', 'my-class');
    expect(el.className).toBe('my-class');
  });

  it('does not set className when not provided', () => {
    const el = createElement('div');
    expect(el.className).toBe('');
  });

  it('does not set className when empty string is passed', () => {
    const el = createElement('div', '');
    expect(el.className).toBe('');
  });

  it('sets textContent when provided', () => {
    const el = createElement('p', undefined, 'Hello');
    expect(el.textContent).toBe('Hello');
  });

  it('sets textContent to empty string when explicitly passed', () => {
    const el = createElement('p', undefined, '');
    expect(el.textContent).toBe('');
  });

  it('does not set textContent when not provided', () => {
    const el = createElement('p');
    expect(el.textContent).toBe('');
  });

  it('sets both className and textContent', () => {
    const el = createElement('h1', 'title', 'Hello World');
    expect(el.className).toBe('title');
    expect(el.textContent).toBe('Hello World');
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for future timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    expect(formatRelativeTime('2025-01-01T00:01:00Z')).toBe('just now');
  });

  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:30Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('just now');
  });

  it('returns minutes format for timestamps 1-59 minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:05:00Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('5m ago');
  });

  it('returns hours format for timestamps 1-23 hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T03:00:00Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('3h ago');
  });

  it('returns days format for timestamps 1-6 days ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-04T00:00:00Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('3d ago');
  });

  it('returns weeks format for timestamps 7+ days ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T00:00:00Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('2w ago');
  });

  it('returns "1m ago" at exactly 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('1m ago');
  });
});

describe('getCooldownRemaining', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 for null timestamp', () => {
    expect(getCooldownRemaining(null, 60000)).toBe(0);
  });

  it('returns remaining ms when cooldown has not expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:30Z'));
    // 30 seconds elapsed, 60 second cooldown → 30000ms remaining
    const remaining = getCooldownRemaining('2025-01-01T00:00:00Z', 60000);
    expect(remaining).toBe(30000);
  });

  it('returns 0 when cooldown has expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:02:00Z'));
    // 120 seconds elapsed, 60 second cooldown → expired
    expect(getCooldownRemaining('2025-01-01T00:00:00Z', 60000)).toBe(0);
  });

  it('returns 0 when cooldown exactly expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    expect(getCooldownRemaining('2025-01-01T00:00:00Z', 60000)).toBe(0);
  });
});

describe('formatCooldownRemaining', () => {
  it('returns empty string for 0 ms', () => {
    expect(formatCooldownRemaining(0)).toBe('');
  });

  it('returns empty string for negative ms', () => {
    expect(formatCooldownRemaining(-1000)).toBe('');
  });

  it('returns minutes for less than an hour', () => {
    expect(formatCooldownRemaining(30000)).toBe('1m'); // 30s → ceil to 1m
    expect(formatCooldownRemaining(60000)).toBe('1m');
    expect(formatCooldownRemaining(120000)).toBe('2m');
    expect(formatCooldownRemaining(3540000)).toBe('59m'); // 59 minutes
  });

  it('returns hours only when remaining minutes is exactly 0', () => {
    expect(formatCooldownRemaining(3600000)).toBe('1h'); // exactly 1 hour
  });

  it('returns hours and minutes for larger values', () => {
    expect(formatCooldownRemaining(3660000)).toBe('1h 1m'); // 61 minutes
    expect(formatCooldownRemaining(5400000)).toBe('1h 30m'); // 90 minutes
    expect(formatCooldownRemaining(7200000)).toBe('2h'); // exactly 2 hours
  });
});

describe('formatSecondsRemaining', () => {
  it('returns "0s" for zero seconds', () => {
    expect(formatSecondsRemaining(0)).toBe('0s');
  });

  it('returns "0s" for negative seconds', () => {
    expect(formatSecondsRemaining(-5)).toBe('0s');
  });

  it('returns seconds with ceil for less than 60', () => {
    expect(formatSecondsRemaining(1)).toBe('1s');
    expect(formatSecondsRemaining(0.5)).toBe('1s');
    expect(formatSecondsRemaining(59)).toBe('59s');
    expect(formatSecondsRemaining(59.1)).toBe('60s');
  });

  it('returns minutes only when remaining seconds is exactly 0', () => {
    expect(formatSecondsRemaining(60)).toBe('1m');
    expect(formatSecondsRemaining(120)).toBe('2m');
  });

  it('returns minutes and seconds for mixed values', () => {
    expect(formatSecondsRemaining(61)).toBe('1m 1s');
    expect(formatSecondsRemaining(90)).toBe('1m 30s');
    expect(formatSecondsRemaining(125)).toBe('2m 5s');
  });
});

describe('normalizeInviteUrl', () => {
  it.each([
    ['https://discord.gg/abc123', 'https://discord.gg/abc123'],
    ['https://discord.com/invite/abc123', 'https://discord.com/invite/abc123'],
    ['https://discordapp.com/invite/abc123', 'https://discordapp.com/invite/abc123'],
    ['  https://discord.gg/my-vanity/  ', 'https://discord.gg/my-vanity'],
    ['discord.gg/abc123', 'https://discord.gg/abc123'],
    ['https://DISCORD.GG/AbC123?event=1#x', 'https://discord.gg/AbC123'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeInviteUrl(input)).toBe(expected);
  });

  it.each([
    '',
    'javascript:alert(1)',
    'http://discord.gg/abc123',
    'https://discord.gg/',
    'https://discord.gg/abc/extra',
    'https://discord.com/abc123',
    'https://discord.com/channels/1/2',
    'https://evil.com/discord.gg/abc123',
    'https://discord.gg.evil.com/abc123',
    'https://user:pass@discord.gg/abc123',
    'https://discord.gg:8443/abc123',
    'https://discord.gg/abc 123',
    'data:text/html,<script>alert(1)</script>',
  ])('rejects %s', (input) => {
    expect(normalizeInviteUrl(input)).toBeNull();
  });
});
