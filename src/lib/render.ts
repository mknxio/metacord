import {
  AuthError,
  RateLimitError,
  fetchGuildMember,
  fetchWidget,
  type ApiGuild,
  type ApiGuildMember,
} from './api';
import {
  toggleFavorite,
  updateNickname,
  updateNotes,
  assignServerToCategory,
  forgetServer,
  saveServerCapture,
  updateDepartureReason,
  updateWidgetCache,
  type InviteSnapshot,
  type MembershipSnapshot,
  type ServerSnapshot,
  type WidgetCacheEntry,
} from './storage';
import {
  createInviteLink,
  createServerCard,
  formatDate,
  type ServerCardOptions,
  type ServerView,
} from '../components/serverCard';
import type { ModalController } from '../components/modal';
import type { ToastManager } from '../components/toast';
import { createElement, formatNumber, getIconUrl, normalizeInviteUrl } from './utils';
import {
  type DynamicSectionKey,
  type FilterKey,
  type SortKey,
  type SectionElements,
  collapsedSections,
  getElement,
  getSections,
  isDemoMode,
  registerDynamicSection,
  clearDynamicSections,
  saveCollapsedSections,
  state,
  storageOptions,
} from './state';

// Re-export ServerView for convenience
export type { ServerView } from '../components/serverCard';

// --- Toast integration ---

let _toast: ToastManager | null = null;
let _appShell: HTMLElement | null = null;

export const initShowToast = (toast: ToastManager, appShell: HTMLElement): void => {
  _toast = toast;
  _appShell = appShell;
};

export const showToast: ToastManager['show'] = (message, options) => {
  if (!_toast || !_appShell) return;
  if (_appShell.getAttribute('aria-hidden') === 'true') {
    return;
  }
  _toast.show(message, options);
};

// --- Screen switching ---

let _closeAppOverlays: (() => void) | null = null;

export const initSetScreen = (closeAppOverlays: () => void): void => {
  _closeAppOverlays = closeAppOverlays;
};

export const setScreen = (screen: 'login' | 'app'): void => {
  const loginScreen = getElement<HTMLElement>('login-screen');
  const appShell = getElement<HTMLElement>('app-shell');
  const isLogin = screen === 'login';
  loginScreen.setAttribute('aria-hidden', isLogin ? 'false' : 'true');
  appShell.setAttribute('aria-hidden', isLogin ? 'true' : 'false');
  loginScreen.classList.toggle('hidden', !isLogin);
  appShell.classList.toggle('hidden', isLogin);
  if (isLogin) {
    _closeAppOverlays?.();
  }
  if (!isLogin) {
    document.querySelectorAll<HTMLElement>('[data-animate]').forEach((el) => {
      el.classList.add('fade-up');
    });
  }
};

// --- Import status ---

export const setImportStatus = (message: string, variant: 'neutral' | 'error' = 'neutral'): void => {
  const importStatus = getElement<HTMLElement>('import-status');
  importStatus.textContent = message;
  importStatus.classList.toggle('is-error', variant === 'error');
};

// --- Filtering & sorting helpers ---

export const hasBoost = (features: string[]): boolean =>
  features.includes('ANIMATED_ICON') || features.includes('ANIMATED_BANNER');

export const getWidgetView = (guildId: string): WidgetCacheEntry | null => {
  return state.userData.widgetCache[guildId] ?? null;
};

export const UNKNOWN_SERVER_NAME = 'Unknown server';

export const buildServerViews = (): ServerView[] => {
  return state.guilds.map((guild) => {
    const widget = getWidgetView(guild.id);
    const snapshot = state.userData.servers[guild.id];
    return {
      id: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      banner: guild.banner ?? null,
      owner: guild.owner,
      features: guild.features ?? [],
      nickname: state.userData.nicknames[guild.id],
      notes: state.userData.notes[guild.id],
      isFavorite: state.userData.favorites.includes(guild.id),
      widget,
      onlineCount: guild.approximate_presence_count ?? widget?.presenceCount ?? null,
      memberCount: guild.approximate_member_count ?? snapshot?.approximateMemberCount ?? null,
      isSaved: Boolean(snapshot?.savedAt),
    };
  });
};

const getDepartedSnapshot = (guildId: string): ServerSnapshot | null => {
  const snapshot = state.userData.servers[guildId];
  if (!snapshot || snapshot.departedAt === null) return null;
  if (state.guilds.some((guild) => guild.id === guildId)) return null;
  return snapshot;
};

/** Rejoin invite for a departed server: the captured invite, else a cached widget invite. */
const getRejoinInvite = (snapshot: ServerSnapshot): string | null =>
  normalizeInviteUrl(snapshot.invite?.url ?? '') ??
  normalizeInviteUrl(state.userData.widgetCache[snapshot.id]?.instantInvite ?? '');

const getCategoryName = (guildId: string): string | null => {
  const categoryId = state.userData.serverCategories[guildId];
  return state.userData.categories.find((category) => category.id === categoryId)?.name ?? null;
};

export const buildDepartedViews = (): ServerView[] => {
  const liveIds = new Set(state.guilds.map((guild) => guild.id));
  return Object.values(state.userData.servers)
    .filter((snapshot) => snapshot.departedAt !== null && !liveIds.has(snapshot.id))
    .map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.name ?? UNKNOWN_SERVER_NAME,
      icon: snapshot.icon,
      banner: snapshot.banner,
      owner: snapshot.owner,
      features: snapshot.features,
      nickname: state.userData.nicknames[snapshot.id],
      notes: state.userData.notes[snapshot.id],
      isFavorite: state.userData.favorites.includes(snapshot.id),
      widget: null,
      onlineCount: snapshot.approximatePresenceCount,
      memberCount: snapshot.approximateMemberCount,
      isSaved: snapshot.savedAt !== null,
      departure: {
        departedAt: snapshot.departedAt ?? '',
        reason: snapshot.departureReason,
        inviteUrl: getRejoinInvite(snapshot),
        isUnknown: snapshot.name === null,
        categoryName: getCategoryName(snapshot.id),
      },
    }));
};

export const matchesSingleFilter = (server: ServerView, filter: FilterKey): boolean => {
  switch (filter) {
    case 'owned':
      return server.owner;
    case 'partner':
      return server.features.includes('PARTNERED');
    case 'verified':
      return server.features.includes('VERIFIED');
    case 'boosted':
      return hasBoost(server.features);
    case 'discoverable':
      return server.features.includes('DISCOVERABLE');
    default:
      return true;
  }
};

export const matchesFilter = (server: ServerView, activeFilters: Set<FilterKey>): boolean => {
  if (activeFilters.size === 0) {
    return true;
  }
  for (const filter of activeFilters) {
    if (!matchesSingleFilter(server, filter)) {
      return false;
    }
  }
  return true;
};

export const matchesSearch = (server: ServerView, query: string): boolean => {
  if (!query) return true;
  const value = query.toLowerCase();
  const nickname = server.nickname?.toLowerCase() ?? '';
  return server.name.toLowerCase().includes(value) || nickname.includes(value);
};

export const getDisplayName = (server: ServerView): string => server.nickname ?? server.name;

export const startsWithAlphanumeric = (value: string): boolean => /^[0-9a-z]/i.test(value.trim());

export const sortByName = (a: ServerView, b: ServerView): number => {
  const nameA = getDisplayName(a);
  const nameB = getDisplayName(b);
  return nameA.localeCompare(nameB);
};

export const sortByBannerThenName = (a: ServerView, b: ServerView): number => {
  const hasBannerA = Boolean(a.banner);
  const hasBannerB = Boolean(b.banner);
  if (hasBannerA !== hasBannerB) {
    return hasBannerA ? -1 : 1;
  }
  const nameA = getDisplayName(a);
  const nameB = getDisplayName(b);
  const alphanumericA = startsWithAlphanumeric(nameA);
  const alphanumericB = startsWithAlphanumeric(nameB);
  if (alphanumericA !== alphanumericB) {
    return alphanumericA ? -1 : 1;
  }
  return nameA.localeCompare(nameB);
};

export const getSortComparator = (sortKey: SortKey): ((a: ServerView, b: ServerView) => number) => {
  switch (sortKey) {
    case 'name-desc':
      return (a, b) => {
        const nameA = getDisplayName(a);
        const nameB = getDisplayName(b);
        return nameB.localeCompare(nameA);
      };
    case 'online-desc':
      return (a, b) => {
        const countA = a.onlineCount ?? -1;
        const countB = b.onlineCount ?? -1;
        if (countA !== countB) return countB - countA;
        return getDisplayName(a).localeCompare(getDisplayName(b));
      };
    case 'name-asc':
    default:
      return sortByName;
  }
};

// --- Section rendering ---

let _detailsModal: ModalController | null = null;

export const initDetailsModal = (modal: ModalController): void => {
  _detailsModal = modal;
};

export const getVisibleServerIds = (): string[] => {
  const allViews = buildServerViews();
  const filtered = allViews.filter((server) =>
    matchesFilter(server, state.activeFilters) && matchesSearch(server, state.search.trim()),
  );
  return filtered.map((s) => s.id);
};

export const toggleSelection = (guildId: string): void => {
  if (state.selectedIds.has(guildId)) {
    state.selectedIds.delete(guildId);
  } else {
    state.selectedIds.add(guildId);
  }
  render();
};

export const confirmForget = (guildId: string): boolean => {
  const snapshot = getDepartedSnapshot(guildId);
  if (!snapshot) return false;
  const label = state.userData.nicknames[guildId] ?? snapshot.name ?? `${UNKNOWN_SERVER_NAME} (${guildId})`;
  const confirmed = confirm(
    `Forget "${label}"? This permanently removes its saved snapshot, notes, nickname, favorite, category and cached widget data.`,
  );
  if (!confirmed) return false;
  state.userData = forgetServer(state.userData, guildId, storageOptions);
  state.selectedIds.delete(guildId);
  showToast('Server forgotten');
  render();
  return true;
};

const renderSection = (key: string, servers: ServerView[]): void => {
  const sections = getSections();
  const section = sections[key];
  if (!section) return;
  section.list.replaceChildren();
  section.count.textContent = `${servers.length}`;
  if (servers.length === 0) {
    section.section.classList.add('hidden');
    return;
  }
  section.section.classList.remove('hidden');
  servers.forEach((server) => {
    // Departed servers are never part of bulk selection.
    const cardOptions: ServerCardOptions | undefined = state.selectionMode && !server.departure
      ? { selectionMode: true, isSelected: state.selectedIds.has(server.id) }
      : undefined;
    section.list.appendChild(
      createServerCard(server, {
        onToggleFavorite: (guildId) => {
          state.userData = toggleFavorite(state.userData, guildId, storageOptions);
          showToast(
            state.userData.favorites.includes(guildId)
              ? 'Added to favorites'
              : 'Removed from favorites',
          );
          render();
        },
        onOpenDetails: (guildId) => openDetails(guildId),
        onToggleSelection: (guildId) => toggleSelection(guildId),
        onForget: server.departure ? (guildId) => confirmForget(guildId) : undefined,
      }, cardOptions),
    );
  });
};

// --- Dynamic category section creation ---

const createCategorySectionDOM = (categoryId: string, categoryName: string): SectionElements => {
  const sectionKey: DynamicSectionKey = `category-${categoryId}`;
  const section = createElement('section', 'section hidden');
  section.id = `${sectionKey}-section`;
  section.setAttribute('data-animate', '');

  const header = document.createElement('button');
  header.className = 'section-header';
  header.type = 'button';
  header.dataset.collapseToggle = sectionKey;
  const isCollapsed = collapsedSections.has(sectionKey);
  header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  header.setAttribute('aria-controls', `${sectionKey}-content`);

  const headerLeft = createElement('div', 'section-header-left');
  const chevron = createElement('span', 'section-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '&#9662;';
  const h2 = createElement('h2', '', categoryName);
  headerLeft.append(chevron, h2);

  const countPill = createElement('span', 'count-pill');
  countPill.id = `${sectionKey}-count`;
  countPill.textContent = '0';

  header.append(headerLeft, countPill);
  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    content.classList.toggle('is-collapsed', expanded);
    if (expanded) {
      collapsedSections.add(sectionKey);
    } else {
      collapsedSections.delete(sectionKey);
    }
    saveCollapsedSections(collapsedSections);
  });

  const content = createElement('div', 'section-content');
  content.id = `${sectionKey}-content`;
  if (isCollapsed) {
    content.classList.add('is-collapsed');
  }

  const list = createElement('div', 'server-grid server-grid--constrained');
  list.id = `${sectionKey}-list`;
  content.appendChild(list);

  section.append(header, content);

  return { section, list, count: countPill, content, header };
};

// --- Main render ---

export const render = (): void => {
  const allViews = buildServerViews();
  const filtered = allViews.filter((server) =>
    matchesFilter(server, state.activeFilters) && matchesSearch(server, state.search.trim()),
  );

  const comparator = getSortComparator(state.sort);
  const favorites = filtered.filter((server) => server.isFavorite).sort(comparator);

  // Build set of servers in custom categories (excluding favorites — favorites take priority)
  const categorizedIds = new Set<string>();
  const sortedCategories = [...state.userData.categories].sort((a, b) => a.order - b.order);

  // Remove old dynamic category sections from DOM and state registry
  const categoryContainer = document.getElementById('category-sections-container');
  if (categoryContainer) {
    categoryContainer.replaceChildren();
  }
  clearDynamicSections();

  // Render each category section
  for (const category of sortedCategories) {
    const sectionKey: DynamicSectionKey = `category-${category.id}`;
    const categoryServers = filtered.filter((server) => {
      if (server.isFavorite) return false;
      return state.userData.serverCategories[server.id] === category.id;
    }).sort(comparator);

    categoryServers.forEach((s) => categorizedIds.add(s.id));

    const elements = createCategorySectionDOM(category.id, category.name);
    registerDynamicSection(sectionKey, elements);
    categoryContainer?.appendChild(elements.section);
    renderSection(sectionKey, categoryServers);
  }

  const owned = filtered.filter((server) =>
    server.owner && !server.isFavorite && !categorizedIds.has(server.id),
  ).sort(comparator);
  const publicServers = filtered.filter((server) =>
    !server.owner && !server.isFavorite && !categorizedIds.has(server.id) && Boolean(server.widget?.instantInvite),
  ).sort(comparator);
  const privateServers = filtered.filter((server) =>
    !server.owner && !server.isFavorite && !categorizedIds.has(server.id) && !server.widget?.instantInvite,
  ).sort(comparator);

  renderSection('favorites', favorites);
  renderSection('owned', owned);
  renderSection('public', publicServers);
  renderSection('private', privateServers);

  const allDeparted = buildDepartedViews();
  const departed = allDeparted.filter((server) =>
    matchesFilter(server, state.activeFilters) && matchesSearch(server, state.search.trim()),
  ).sort(comparator);
  renderSection('departed', departed);

  const statTotal = getElement<HTMLElement>('stat-total');
  const statFavorites = getElement<HTMLElement>('stat-favorites');
  const statOwned = getElement<HTMLElement>('stat-owned');
  const statPublic = getElement<HTMLElement>('stat-public');
  const emptyState = getElement<HTMLElement>('empty-state');
  const searchHelper = getElement<HTMLElement>('search-helper');

  const favoritesTotal = allViews.filter((server) => server.isFavorite).length;
  const ownedTotal = allViews.filter((server) => server.owner).length;
  const publicTotal = allViews.filter((server) => server.widget?.instantInvite).length;
  statTotal.textContent = `${allViews.length}`;
  statFavorites.textContent = `${favoritesTotal}`;
  statOwned.textContent = `${ownedTotal}`;
  statPublic.textContent = `${publicTotal}`;

  // Search feedback and the empty state cover every rendered card, departed ones included.
  const cardTotal = allViews.length + allDeparted.length;
  emptyState.classList.toggle('hidden', cardTotal > 0);
  searchHelper.classList.toggle('hidden', state.search.trim().length > 0);

  // Update filter count badge
  const filterCount = document.getElementById('filter-count');
  if (filterCount) {
    const hasActiveFilters = state.activeFilters.size > 0 || state.search.trim().length > 0;
    if (hasActiveFilters && cardTotal > 0) {
      filterCount.textContent = `${filtered.length + departed.length} of ${cardTotal} servers`;
      filterCount.classList.remove('hidden');
    } else {
      filterCount.textContent = '';
      filterCount.classList.add('hidden');
    }
  }

  // Update bulk action bar
  const bulkActions = document.getElementById('bulk-actions');
  const bulkCount = document.getElementById('bulk-count');
  const selectToggle = document.getElementById('btn-select-toggle');
  if (bulkActions && bulkCount) {
    const selectedCount = state.selectedIds.size;
    if (state.selectionMode && selectedCount > 0) {
      bulkActions.classList.remove('hidden');
      bulkCount.textContent = `${selectedCount} selected`;
    } else {
      bulkActions.classList.add('hidden');
      bulkCount.textContent = '';
    }
  }
  if (selectToggle) {
    selectToggle.classList.toggle('is-active', state.selectionMode);
    selectToggle.setAttribute('aria-pressed', state.selectionMode ? 'true' : 'false');
  }
};

// --- Details modal ---

const createDetailsHeader = (
  guildId: string,
  name: string,
  iconHash: string | null,
  fallbackInitial: string,
): HTMLElement => {
  const header = createElement('div', 'details-header');
  const icon = createElement('div', 'details-icon');
  const iconUrl = getIconUrl(guildId, iconHash);
  if (iconUrl) {
    const image = document.createElement('img');
    image.src = iconUrl;
    image.alt = `${name} icon`;
    image.onerror = () => image.remove();
    icon.appendChild(image);
  } else {
    icon.textContent = fallbackInitial;
  }
  header.appendChild(icon);

  const headerText = createElement('div', 'details-title');
  headerText.appendChild(createElement('h4', '', name));
  const idRow = createElement('div', 'details-id-row');
  const idText = createElement('span', 'muted', `ID: ${guildId}`);
  const copyButton = createElement('button', 'btn btn-secondary', 'Copy ID');
  copyButton.type = 'button';
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(guildId);
      showToast('Server ID copied');
    } catch {
      showToast('Unable to copy ID', { variant: 'error' });
    }
  });
  idRow.append(idText, copyButton);
  headerText.appendChild(idRow);
  header.appendChild(headerText);
  return header;
};

interface AnnotationFields {
  element: HTMLElement;
  save: () => void;
}

/** Nickname, notes and category inputs shared by current and departed servers. */
const createAnnotationFields = (guildId: string): AnnotationFields => {
  const element = createElement('div', 'details-annotations');

  const nicknameField = createElement('div', 'form-field');
  const nicknameLabel = createElement('label', '', 'Nickname');
  nicknameLabel.setAttribute('for', 'nickname-input');
  const nicknameInput = document.createElement('input');
  nicknameInput.id = 'nickname-input';
  nicknameInput.type = 'text';
  nicknameInput.value = state.userData.nicknames[guildId] ?? '';
  nicknameField.append(nicknameLabel, nicknameInput);
  element.appendChild(nicknameField);

  const notesField = createElement('div', 'form-field');
  const notesLabel = createElement('label', '', 'Notes');
  notesLabel.setAttribute('for', 'notes-input');
  const notesInput = document.createElement('textarea');
  notesInput.id = 'notes-input';
  notesInput.value = state.userData.notes[guildId] ?? '';
  notesField.append(notesLabel, notesInput);
  element.appendChild(notesField);

  const categoryField = createElement('div', 'form-field');
  const categoryLabel = createElement('label', '', 'Category');
  categoryLabel.setAttribute('for', 'category-select');
  const categorySelect = document.createElement('select');
  categorySelect.id = 'category-select';
  categorySelect.className = 'sort-select';

  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'None';
  categorySelect.appendChild(noneOption);

  const sortedCats = [...state.userData.categories].sort((a, b) => a.order - b.order);
  for (const cat of sortedCats) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    categorySelect.appendChild(opt);
  }
  categorySelect.value = state.userData.serverCategories[guildId] ?? '';
  categoryField.append(categoryLabel, categorySelect);
  element.appendChild(categoryField);

  const save = (): void => {
    state.userData = updateNickname(state.userData, guildId, nicknameInput.value, storageOptions);
    state.userData = updateNotes(state.userData, guildId, notesInput.value, storageOptions);
    const selectedCategory = categorySelect.value || null;
    state.userData = assignServerToCategory(state.userData, guildId, selectedCategory, storageOptions);
  };

  return { element, save };
};

const createReasonField = (guildId: string, label: string): { element: HTMLElement; input: HTMLTextAreaElement } => {
  const field = createElement('div', 'form-field');
  const reasonLabel = createElement('label', '', label);
  reasonLabel.setAttribute('for', 'departure-reason-input');
  const input = document.createElement('textarea');
  input.id = 'departure-reason-input';
  input.maxLength = 500;
  input.value = state.userData.servers[guildId]?.departureReason ?? '';
  field.append(reasonLabel, input);
  return { element: field, input };
};

// --- Widget rate-limit coordination ---

/**
 * Lets Save for later respect and update the toolbar's widget rate-limit window without
 * importing the fetch orchestrator (which imports this module).
 */
export interface WidgetRateLimitHooks {
  isActive: () => boolean;
  report: (retryAfterSeconds: number | null) => void;
}

let _widgetRateLimit: WidgetRateLimitHooks = { isActive: () => false, report: () => {} };

export const initWidgetRateLimit = (hooks: WidgetRateLimitHooks): void => {
  _widgetRateLimit = hooks;
};

const formatCount = (value: number | null | undefined): string =>
  typeof value === 'number' ? formatNumber(value) : 'Unknown';

/**
 * Resolves a rejoin invite from the widget: the cached instant invite, otherwise one
 * widget request (skipped while a rate-limit window is active). Returns null when there
 * is none; AuthError is rethrown for the caller.
 */
const resolveWidgetInvite = async (guildId: string, nowIso: string): Promise<InviteSnapshot | null> => {
  const cachedUrl = normalizeInviteUrl(state.userData.widgetCache[guildId]?.instantInvite ?? '');
  if (cachedUrl) {
    return { url: cachedUrl, source: 'widget', capturedAt: nowIso };
  }
  if (isDemoMode) return null;
  if (_widgetRateLimit.isActive()) {
    showToast('Rate limited by Discord. Saved without checking the widget invite.', { variant: 'error' });
    return null;
  }
  try {
    const widget = await fetchWidget(guildId);
    state.userData = updateWidgetCache(
      state.userData,
      guildId,
      {
        instantInvite: widget.instant_invite ?? null,
        presenceCount: widget.presence_count ?? null,
        lastCached: nowIso,
      },
      storageOptions,
    );
    const url = normalizeInviteUrl(widget.instant_invite ?? '');
    return url ? { url, source: 'widget', capturedAt: nowIso } : null;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof RateLimitError) {
      _widgetRateLimit.report(error.retryAfter);
      showToast('Rate limited by Discord. Saved without checking the widget invite.', { variant: 'error' });
    } else {
      showToast('Widget unavailable. Saved without a widget invite.', { variant: 'info' });
    }
    return null;
  }
};

const describeSavedStatus = (snapshot: ServerSnapshot | undefined): string => {
  if (!snapshot?.savedAt) {
    return 'Not saved. Saving captures your membership details, server counts and a rejoin invite so they survive leaving.';
  }
  const parts = [`Saved ${formatDate(snapshot.savedAt)}`];
  if (snapshot.membership) {
    parts.push(`membership captured ${formatDate(snapshot.membership.capturedAt)}`);
  }
  parts.push(snapshot.invite ? 'rejoin invite captured' : 'no rejoin invite');
  return `${parts.join(' · ')}.`;
};

const toMembershipSnapshot = (member: ApiGuildMember, capturedAt: string): MembershipSnapshot => ({
  joinedAt: member.joined_at ?? null,
  nickname: member.nickname ?? null,
  roleCount: member.roles?.length ?? 0,
  capturedAt,
});

/**
 * Refresh capture fetches membership again rather than re-stamping what the modal loaded.
 * Returns null (saveServerCapture then keeps the previous capture and its timestamp) when
 * that fetch fails; AuthError is rethrown for the caller.
 */
const fetchFreshMembership = async (guildId: string): Promise<MembershipSnapshot | null> => {
  if (isDemoMode) return null;
  try {
    const fresh = await fetchGuildMember(guildId);
    return toMembershipSnapshot(fresh, new Date().toISOString());
  } catch (error) {
    if (error instanceof AuthError) throw error;
    showToast('Membership details could not be refreshed; kept the previous capture.', { variant: 'info' });
    return null;
  }
};

/** `memberReceivedAt` is when `member` (loaded with the modal) arrived; it dates that capture. */
const createSaveForLaterSection = (
  guild: ApiGuild,
  member: ApiGuildMember | null,
  memberReceivedAt: string | null,
): { element: HTMLElement; reasonInput: HTMLTextAreaElement } => {
  const guildId = guild.id;
  const section = createElement('section', 'save-later');
  section.setAttribute('aria-labelledby', 'save-later-title');
  const title = createElement('h5', 'save-later-title', 'Save for later');
  title.id = 'save-later-title';
  section.appendChild(title);

  const status = createElement('p', 'muted save-later-status');
  status.setAttribute('role', 'status');
  status.textContent = describeSavedStatus(state.userData.servers[guildId]);
  section.appendChild(status);

  const currentInvite = createElement('p', 'save-later-invite');
  const renderCurrentInvite = (): void => {
    currentInvite.replaceChildren();
    const invite = state.userData.servers[guildId]?.invite;
    const link = createInviteLink(invite?.url, 'text-link', invite?.url ?? '', 'Open captured rejoin invite');
    if (invite && link) {
      currentInvite.append(`Captured invite (${invite.source}): `, link);
    }
  };
  renderCurrentInvite();
  section.appendChild(currentInvite);

  const inviteField = createElement('div', 'form-field');
  const inviteLabel = createElement('label', '', 'Rejoin invite (optional)');
  inviteLabel.setAttribute('for', 'invite-input');
  const inviteInput = document.createElement('input');
  inviteInput.id = 'invite-input';
  inviteInput.type = 'url';
  inviteInput.placeholder = 'https://discord.gg/…';
  inviteInput.autocomplete = 'off';
  const existingInvite = state.userData.servers[guildId]?.invite;
  inviteInput.value = existingInvite?.source === 'manual' ? existingInvite.url : '';
  const inviteHelp = createElement(
    'p',
    'muted form-help',
    'Leave empty to use the server widget invite when available. Accepts discord.gg/… and discord.com/invite/… links.',
  );
  inviteHelp.id = 'invite-help';
  inviteInput.setAttribute('aria-describedby', 'invite-help invite-error');
  const inviteError = createElement('p', 'form-error');
  inviteError.id = 'invite-error';
  inviteError.setAttribute('role', 'alert');
  inviteField.append(inviteLabel, inviteInput, inviteHelp, inviteError);
  section.appendChild(inviteField);

  const reason = createReasonField(guildId, 'Why you might leave (optional)');
  section.appendChild(reason.element);

  const captureButton = createElement('button', 'btn btn-secondary');
  captureButton.type = 'button';
  const updateButtonLabel = (): void => {
    captureButton.textContent = state.userData.servers[guildId]?.savedAt ? 'Refresh capture' : 'Save for later';
  };
  updateButtonLabel();

  captureButton.addEventListener('click', async () => {
    inviteError.textContent = '';
    inviteInput.removeAttribute('aria-invalid');
    const nowIso = new Date().toISOString();
    let invite: InviteSnapshot | null = null;
    const pasted = inviteInput.value.trim();
    if (pasted.length > 0) {
      const url = normalizeInviteUrl(pasted);
      if (!url) {
        inviteError.textContent = 'Enter a discord.gg/… or discord.com/invite/… link.';
        inviteInput.setAttribute('aria-invalid', 'true');
        inviteInput.focus();
        return;
      }
      invite = { url, source: 'manual', capturedAt: nowIso };
    }

    const wasSaved = Boolean(state.userData.servers[guildId]?.savedAt);
    // Another tab may have noticed the departure while this tab still lists the server:
    // only a fresh member response can show the user is still in it.
    const isDeparted = (): boolean => (state.userData.servers[guildId]?.departedAt ?? null) !== null;
    let membership: MembershipSnapshot | null =
      member && memberReceivedAt ? toMembershipSnapshot(member, memberReceivedAt) : null;
    let memberConfirmed = false;
    captureButton.disabled = true;
    try {
      if (!invite) {
        invite = await resolveWidgetInvite(guildId, nowIso);
      }
      if (wasSaved || isDeparted()) {
        membership = await fetchFreshMembership(guildId);
        memberConfirmed = membership !== null;
      }
    } catch (error) {
      if (error instanceof AuthError) {
        setScreen('login');
        return;
      }
      throw error;
    } finally {
      captureButton.disabled = false;
    }

    const next = saveServerCapture(
      state.userData,
      guild,
      { membership, invite, departureReason: reason.input.value, memberConfirmed },
      nowIso,
      storageOptions,
    );
    if (next === state.userData && isDeparted()) {
      showToast('This server is no longer in your server list. Nothing was saved.', { variant: 'error' });
      return;
    }
    state.userData = next;
    status.textContent = describeSavedStatus(state.userData.servers[guildId]);
    renderCurrentInvite();
    updateButtonLabel();
    showToast(wasSaved ? 'Capture refreshed' : 'Saved for later', { variant: 'success' });
    render();
  });
  section.appendChild(captureButton);
  return { element: section, reasonInput: reason.input };
};

const openDepartedDetails = (snapshot: ServerSnapshot): void => {
  const guildId = snapshot.id;
  const detailsBody = getElement<HTMLElement>('details-body');
  detailsBody.replaceChildren();
  const name = snapshot.name ?? UNKNOWN_SERVER_NAME;
  detailsBody.appendChild(
    createDetailsHeader(guildId, name, snapshot.icon, snapshot.name ? snapshot.name.charAt(0).toUpperCase() : '?'),
  );

  // Captured data only: departed servers never trigger live Discord requests.
  const meta = createElement('div', 'details-meta');
  meta.appendChild(createElement('div', 'detail-row', `Left (noticed) ${formatDate(snapshot.departedAt ?? '')}`));
  if (snapshot.lastSeenAt) {
    meta.appendChild(createElement('div', 'detail-row', `Last seen: ${formatDate(snapshot.lastSeenAt)}`));
  } else {
    meta.appendChild(
      createElement('div', 'detail-row', 'Left before Metacord kept server history; only your annotations remain.'),
    );
  }
  if (snapshot.firstSeenAt) {
    meta.appendChild(createElement('div', 'detail-row', `First seen: ${formatDate(snapshot.firstSeenAt)}`));
  }
  if (snapshot.savedAt) {
    meta.appendChild(createElement('div', 'detail-row', `Saved for later: ${formatDate(snapshot.savedAt)}`));
  }
  meta.appendChild(
    createElement(
      'div',
      'detail-row',
      `Members: ${formatCount(snapshot.approximateMemberCount)} · Online: ${formatCount(snapshot.approximatePresenceCount)} (last seen)`,
    ),
  );
  if (snapshot.membership) {
    const joined = snapshot.membership.joinedAt ? formatDate(snapshot.membership.joinedAt) : 'Unknown';
    meta.appendChild(createElement('div', 'detail-row', `Joined: ${joined}`));
    meta.appendChild(
      createElement('div', 'detail-row', `Server nickname: ${snapshot.membership.nickname ?? 'None'}`),
    );
    meta.appendChild(createElement('div', 'detail-row', `Roles: ${snapshot.membership.roleCount}`));
    meta.appendChild(
      createElement('div', 'detail-row muted', `Membership captured ${formatDate(snapshot.membership.capturedAt)}`),
    );
  } else {
    meta.appendChild(createElement('div', 'detail-row muted', 'No membership details were captured before leaving.'));
  }
  detailsBody.appendChild(meta);

  const rejoinUrl = getRejoinInvite(snapshot);
  const rejoin = createInviteLink(rejoinUrl, 'btn btn-primary', 'Rejoin', `Rejoin ${name} (opens Discord invite)`);
  if (rejoin) {
    const rejoinRow = createElement('div', 'details-rejoin');
    rejoinRow.appendChild(rejoin);
    detailsBody.appendChild(rejoinRow);
  } else {
    detailsBody.appendChild(createElement('p', 'muted', 'No rejoin invite was captured.'));
  }

  const annotations = createAnnotationFields(guildId);
  detailsBody.appendChild(annotations.element);
  const reason = createReasonField(guildId, 'Departure reason');
  detailsBody.appendChild(reason.element);

  const actions = createElement('div', 'modal-actions');
  const saveButton = createElement('button', 'btn btn-primary', 'Save');
  saveButton.type = 'button';
  saveButton.addEventListener('click', () => {
    annotations.save();
    state.userData = updateDepartureReason(state.userData, guildId, reason.input.value, storageOptions);
    showToast('Details saved');
    render();
    _detailsModal?.close();
  });
  const forgetButton = createElement('button', 'btn btn-danger', 'Forget');
  forgetButton.type = 'button';
  forgetButton.addEventListener('click', () => {
    if (confirmForget(guildId)) {
      _detailsModal?.close();
    }
  });
  const cancelButton = createElement('button', 'btn btn-secondary', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => _detailsModal?.close());
  actions.append(saveButton, forgetButton, cancelButton);
  detailsBody.appendChild(actions);
  _detailsModal?.open();
};

export const openDetails = async (guildId: string): Promise<void> => {
  const server = state.guilds.find((item) => item.id === guildId);
  if (!server) {
    const departed = getDepartedSnapshot(guildId);
    if (departed) {
      openDepartedDetails(departed);
    }
    return;
  }
  const detailsBody = getElement<HTMLElement>('details-body');
  detailsBody.replaceChildren();

  const loading = createElement('p', 'muted', 'Loading server details...');
  detailsBody.appendChild(loading);
  _detailsModal?.open();

  let member: ApiGuildMember | null = null;
  let memberReceivedAt: string | null = null;
  if (!isDemoMode) {
    try {
      member = await fetchGuildMember(guildId);
      memberReceivedAt = new Date().toISOString();
    } catch (error) {
      if (error instanceof AuthError) {
        setScreen('login');
        return;
      }
      detailsBody.replaceChildren(createElement('p', 'muted', 'Unable to load server details.'));
      return;
    }
  }

  detailsBody.replaceChildren();
  detailsBody.appendChild(
    createDetailsHeader(server.id, server.name, server.icon ?? null, server.name.charAt(0).toUpperCase()),
  );

  const meta = createElement('div', 'details-meta');
  const joinedAt = member?.joined_at ? new Date(member.joined_at).toLocaleDateString() : 'Unknown';
  const rolesCount = member?.roles ? member.roles.length : 0;
  const widgetStatus = state.userData.widgetCache[guildId]?.instantInvite ? 'Widget enabled' : 'Widget off';
  meta.appendChild(createElement('div', 'detail-row', `Joined: ${joinedAt}`));
  meta.appendChild(createElement('div', 'detail-row', `Roles: ${rolesCount}`));
  meta.appendChild(
    createElement(
      'div',
      'detail-row',
      `Members: ${formatCount(server.approximate_member_count)} · Online: ${formatCount(
        server.approximate_presence_count ?? state.userData.widgetCache[guildId]?.presenceCount,
      )}`,
    ),
  );
  meta.appendChild(createElement('div', 'detail-row', widgetStatus));
  detailsBody.appendChild(meta);

  const roles = member?.roles ?? [];
  const rolesSection = createElement('div', 'roles-section');
  const rolesHeader = createElement('div', 'roles-header');
  const rolesLabel = createElement('span', 'roles-label', `Roles (${roles.length})`);
  rolesHeader.appendChild(rolesLabel);
  rolesSection.appendChild(rolesHeader);

  if (roles.length > 0) {
    const rolesList = createElement('div', 'roles-list');
    rolesList.setAttribute('role', 'list');
    rolesList.setAttribute('aria-label', 'Role IDs');
    for (const roleId of roles) {
      const item = createElement('div');
      item.setAttribute('role', 'listitem');
      const badge = createElement('button', 'role-badge');
      badge.type = 'button';
      badge.textContent = roleId;
      badge.setAttribute('aria-label', `Role ID ${roleId}, click to copy`);
      badge.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(roleId);
          showToast('Role ID copied');
        } catch {
          showToast('Unable to copy role ID', { variant: 'error' });
        }
      });
      item.appendChild(badge);
      rolesList.appendChild(item);
    }
    rolesSection.appendChild(rolesList);
    const rolesNote = createElement('p', 'roles-note muted', 'Role names require bot permissions — showing role IDs');
    rolesSection.appendChild(rolesNote);
  } else {
    const noRoles = createElement('p', 'muted', 'No roles');
    rolesSection.appendChild(noRoles);
  }
  detailsBody.appendChild(rolesSection);

  const annotations = createAnnotationFields(guildId);
  detailsBody.appendChild(annotations.element);

  const saveForLater = createSaveForLaterSection(server, member, memberReceivedAt);
  detailsBody.appendChild(saveForLater.element);

  const actions = createElement('div', 'modal-actions');
  const saveButton = createElement('button', 'btn btn-primary', 'Save');
  saveButton.type = 'button';
  saveButton.addEventListener('click', () => {
    annotations.save();
    state.userData = updateDepartureReason(state.userData, guildId, saveForLater.reasonInput.value, storageOptions);
    showToast('Details saved');
    render();
    _detailsModal?.close();
  });
  const cancelButton = createElement('button', 'btn btn-secondary', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => _detailsModal?.close());
  actions.append(saveButton, cancelButton);
  detailsBody.appendChild(actions);
};
