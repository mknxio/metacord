export const formatNumber = (value: number): string => {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`;
  }
  return `${value}`;
};

export const getIconUrl = (guildId: string, iconHash?: string | null): string | null => {
  if (!iconHash) return null;
  const extension = iconHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${extension}`;
};

export const getBannerUrl = (guildId: string, bannerHash?: string | null): string | null => {
  if (!bannerHash) return null;
  return `https://cdn.discordapp.com/banners/${guildId}/${bannerHash}.png?size=480`;
};

export const createElement = <T extends keyof HTMLElementTagNameMap>(
  tag: T,
  className?: string,
  textContent?: string,
): HTMLElementTagNameMap[T] => {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (textContent !== undefined) {
    element.textContent = textContent;
  }
  return element;
};

export const safelySetText = (element: HTMLElement, value: string): void => {
  element.textContent = value;
};

export const formatRelativeTime = (isoTimestamp: string): string => {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return `${weeks}w ago`;
};

export const getCooldownRemaining = (lastFetchTimestamp: string | null, cooldownMs: number): number => {
  if (!lastFetchTimestamp) return 0;
  const now = Date.now();
  const then = new Date(lastFetchTimestamp).getTime();
  const elapsed = now - then;
  const remaining = cooldownMs - elapsed;
  return remaining > 0 ? remaining : 0;
};

export const formatCooldownRemaining = (remainingMs: number): string => {
  if (remainingMs <= 0) return '';
  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
};

export const formatSecondsRemaining = (seconds: number): string => {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
};

const INVITE_HOST_PREFIXES: Record<string, string> = {
  'discord.gg': '/',
  'discord.com': '/invite/',
  'discordapp.com': '/invite/',
};

const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{2,64}$/;

/**
 * Validates a Discord invite URL and returns its canonical https form, or null.
 *
 * Only https://discord.gg/<code>, https://discord.com/invite/<code>, and
 * https://discordapp.com/invite/<code> are accepted (a missing scheme is treated as
 * https). Invite URLs can arrive from imported files, so anything that is not one of
 * these exact shapes must never be rendered as a link.
 */
export const normalizeInviteUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const prefix = INVITE_HOST_PREFIXES[host];
  if (!prefix || !url.pathname.startsWith(prefix)) return null;
  const code = url.pathname.slice(prefix.length).replace(/\/$/, '');
  if (!INVITE_CODE_PATTERN.test(code)) return null;
  return `https://${host}${prefix}${code}`;
};
