import { createElement, formatNumber, getBannerUrl, getIconUrl, normalizeInviteUrl } from '../lib/utils';

export interface ServerWidgetView {
  instantInvite: string | null;
  presenceCount: number | null;
}

export interface ServerDepartureView {
  departedAt: string;
  reason: string | null;
  /** Already validated with normalizeInviteUrl. */
  inviteUrl: string | null;
  /** Recovered from annotations only; the real name was never captured. */
  isUnknown: boolean;
  categoryName: string | null;
}

export interface ServerView {
  id: string;
  name: string;
  icon?: string | null;
  banner?: string | null;
  owner: boolean;
  features: string[];
  nickname?: string;
  notes?: string;
  isFavorite: boolean;
  widget?: ServerWidgetView | null;
  /** Online count: guild-list presence count, falling back to widget presence. */
  onlineCount?: number | null;
  memberCount?: number | null;
  isSaved?: boolean;
  departure?: ServerDepartureView | null;
}

export interface ServerCardOptions {
  selectionMode?: boolean;
  isSelected?: boolean;
}

export interface ServerCardHandlers {
  onToggleFavorite: (guildId: string) => void;
  onOpenDetails: (guildId: string) => void;
  onToggleSelection?: (guildId: string) => void;
  onForget?: (guildId: string) => void;
}

export const formatDate = (isoTimestamp: string): string => {
  const date = new Date(isoTimestamp);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString();
};

/** Opens a validated invite in a new tab; returns null for anything that is not a Discord invite. */
export const createInviteLink = (
  url: string | null | undefined,
  className: string,
  text: string,
  ariaLabel: string,
): HTMLAnchorElement | null => {
  const href = url ? normalizeInviteUrl(url) : null;
  if (!href) return null;
  const link = createElement('a', className, text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', ariaLabel);
  link.addEventListener('click', (event) => event.stopPropagation());
  // Keep the card's Enter/Space handler from swallowing link activation.
  link.addEventListener('keydown', (event) => event.stopPropagation());
  return link;
};

const createDepartureDetails = (
  server: ServerView,
  departure: ServerDepartureView,
  handlers: ServerCardHandlers,
): HTMLElement => {
  const details = createElement('div', 'departure-details');
  details.appendChild(createElement('div', 'departure-date', `Left (noticed) ${formatDate(departure.departedAt)}`));
  if (departure.reason) {
    details.appendChild(createElement('div', 'departure-reason', departure.reason));
  }
  if (server.notes) {
    details.appendChild(createElement('div', 'departure-notes', server.notes));
  }

  const actions = createElement('div', 'departure-actions');
  const rejoin = createInviteLink(
    departure.inviteUrl,
    'btn btn-secondary btn-sm',
    'Rejoin',
    `Rejoin ${server.nickname ?? server.name} (opens Discord invite)`,
  );
  if (rejoin) {
    actions.appendChild(rejoin);
  }
  if (handlers.onForget) {
    const forget = createElement('button', 'btn btn-ghost btn-sm', 'Forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', `Forget ${server.nickname ?? server.name}`);
    forget.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onForget?.(server.id);
    });
    forget.addEventListener('keydown', (event) => event.stopPropagation());
    actions.appendChild(forget);
  }
  details.appendChild(actions);
  return details;
};

const hasBoost = (features: string[]): boolean =>
  features.includes('ANIMATED_ICON') || features.includes('ANIMATED_BANNER');

export const createServerCard = (
  server: ServerView,
  handlers: ServerCardHandlers,
  options?: ServerCardOptions,
): HTMLElement => {
  const card = createElement('article', 'server-card');
  card.tabIndex = 0;
  if (options?.selectionMode) {
    card.setAttribute('role', 'checkbox');
    card.setAttribute('aria-checked', options.isSelected ? 'true' : 'false');
    card.setAttribute('aria-label', `Select ${server.nickname ?? server.name}`);
  } else {
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open details for ${server.nickname ?? server.name}`);
  }
  card.dataset.guildId = server.id;

  if (server.owner) {
    card.classList.add('is-owned');
  }
  if (server.isFavorite) {
    card.classList.add('is-favorite');
  }
  if (server.departure) {
    card.classList.add('is-departed');
  }

  if (options?.selectionMode) {
    card.classList.add('is-selectable');
    if (options.isSelected) {
      card.classList.add('is-selected');
    }

    const checkbox = createElement('div', 'card-checkbox');
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', options.isSelected ? 'true' : 'false');
    checkbox.setAttribute('aria-label', `Select ${server.nickname ?? server.name}`);
    checkbox.tabIndex = 0;

    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
      handlers.onToggleSelection?.(server.id);
    });
    checkbox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        handlers.onToggleSelection?.(server.id);
      }
    });
    card.appendChild(checkbox);
  }

  const bannerUrl = getBannerUrl(server.id, server.banner ?? null);
  if (bannerUrl) {
    const banner = createElement('div', 'server-card-banner');
    banner.style.backgroundImage = `url(${bannerUrl})`;
    card.appendChild(banner);
  }

  const actions = createElement('div', 'card-actions');
  const favoriteButton = createElement('button', 'card-action');
  favoriteButton.type = 'button';
  favoriteButton.setAttribute('aria-pressed', server.isFavorite ? 'true' : 'false');
  favoriteButton.setAttribute('aria-label', server.isFavorite ? 'Unfavorite server' : 'Favorite server');
  favoriteButton.textContent = server.isFavorite ? '★' : '☆';
  if (server.isFavorite) {
    favoriteButton.classList.add('is-favorite');
  }
  favoriteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    handlers.onToggleFavorite(server.id);
  });
  actions.appendChild(favoriteButton);

  if (!server.departure) {
    const inviteLink = createInviteLink(server.widget?.instantInvite, 'card-action invite-link', '↗', 'Open public invite');
    if (inviteLink) {
      actions.appendChild(inviteLink);
    }
  }

  card.appendChild(actions);

  const icon = createElement('div', 'server-icon');
  const iconUrl = getIconUrl(server.id, server.icon ?? null);
  if (iconUrl) {
    const image = document.createElement('img');
    image.src = iconUrl;
    image.alt = `${server.name} icon`;
    image.loading = 'lazy';
    image.onerror = () => image.remove();
    icon.appendChild(image);
  } else {
    icon.textContent = server.departure?.isUnknown ? '?' : server.name.charAt(0).toUpperCase();
  }
  card.appendChild(icon);

  const content = createElement('div', 'server-card-content');
  const displayName = server.nickname && server.nickname.trim().length > 0 ? server.nickname : server.name;
  const nameRow = createElement('div', 'server-name-row');
  const name = createElement('div', 'server-name', displayName);
  nameRow.appendChild(name);
  content.appendChild(nameRow);

  if (displayName !== server.name) {
    const realName = createElement('div', 'server-real-name', server.name);
    content.appendChild(realName);
  }

  if (server.departure?.isUnknown) {
    content.appendChild(createElement('div', 'server-real-name', `ID: ${server.id}`));
  }

  const badges = createElement('div', 'server-badges');
  if (server.departure) {
    badges.appendChild(createElement('span', 'badge badge-departed', 'Departed'));
  }
  if (server.isSaved) {
    badges.appendChild(createElement('span', 'badge badge-saved', 'Saved'));
  }
  if (server.departure?.categoryName) {
    badges.appendChild(createElement('span', 'badge badge-category', server.departure.categoryName));
  }
  if (server.owner) {
    badges.appendChild(createElement('span', 'badge badge-owner', 'Owner'));
  }
  if (server.features.includes('PARTNERED')) {
    badges.appendChild(createElement('span', 'badge badge-partner', 'Partner'));
  }
  if (server.features.includes('VERIFIED')) {
    badges.appendChild(createElement('span', 'badge badge-verified', 'Verified'));
  }
  if (hasBoost(server.features)) {
    badges.appendChild(createElement('span', 'badge badge-boosted', 'Boosted'));
  }
  if (server.features.includes('DISCOVERABLE')) {
    badges.appendChild(createElement('span', 'badge badge-discoverable', 'Discoverable'));
  }
  if (badges.children.length > 0) {
    content.appendChild(badges);
  }

  const meta = createElement('div', 'server-meta');
  if (server.onlineCount) {
    const online = createElement('span', 'online-count');
    online.setAttribute('aria-label', `${formatNumber(server.onlineCount)} online`);
    const dot = createElement('span', 'online-dot');
    dot.setAttribute('aria-hidden', 'true');
    online.appendChild(dot);
    online.appendChild(document.createTextNode(formatNumber(server.onlineCount)));
    meta.appendChild(online);
  }
  if (typeof server.memberCount === 'number') {
    const members = createElement('span', 'member-count', `${formatNumber(server.memberCount)} members`);
    members.setAttribute('aria-label', `${formatNumber(server.memberCount)} members`);
    meta.appendChild(members);
  }
  if (meta.children.length > 0) {
    content.appendChild(meta);
  }

  if (server.departure) {
    content.appendChild(createDepartureDetails(server, server.departure, handlers));
  }

  card.appendChild(content);

  const openDetails = (): void => handlers.onOpenDetails(server.id);
  card.addEventListener('click', () => {
    if (options?.selectionMode) {
      handlers.onToggleSelection?.(server.id);
    } else {
      openDetails();
    }
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (options?.selectionMode) {
        handlers.onToggleSelection?.(server.id);
      } else {
        openDetails();
      }
    }
  });

  return card;
};
