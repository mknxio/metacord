import { normalizeInviteUrl } from './utils';

export interface WidgetCacheEntry {
  instantInvite: string | null;
  presenceCount: number | null;
  lastCached: string | null;
}

export interface CategoryDefinition {
  id: string;
  name: string;
  order: number;
}

export interface MembershipSnapshot {
  joinedAt: string | null;
  nickname: string | null;
  roleCount: number;
  capturedAt: string;
}

export type InviteSource = 'widget' | 'manual';

export interface InviteSnapshot {
  url: string;
  source: InviteSource;
  capturedAt: string;
}

/**
 * Persisted per-server record built from observed guild lists.
 *
 * `name === null` marks a server recovered only from orphaned annotations (left before
 * snapshots existed); the UI labels it "Unknown server" instead of persisting a fake name.
 */
export interface ServerSnapshot {
  id: string;
  name: string | null;
  icon: string | null;
  banner: string | null;
  owner: boolean;
  features: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  approximateMemberCount: number | null;
  approximatePresenceCount: number | null;
  membership: MembershipSnapshot | null;
  invite: InviteSnapshot | null;
  savedAt: string | null;
  departedAt: string | null;
  departureReason: string | null;
}

export const CURRENT_USER_DATA_VERSION = 3;

export class UnsupportedUserDataVersionError extends Error {
  version: number;
  constructor(version: number) {
    super(`User data version ${version} is newer than this app supports (${CURRENT_USER_DATA_VERSION})`);
    this.name = 'UnsupportedUserDataVersionError';
    this.version = version;
  }
}

export interface UserDataStore {
  version: number;
  favorites: string[];
  nicknames: Record<string, string>;
  notes: Record<string, string>;
  widgetCache: Record<string, WidgetCacheEntry>;
  lastFetchTimestamp: string | null;
  categories: CategoryDefinition[];
  serverCategories: Record<string, string>;
  servers: Record<string, ServerSnapshot>;
}

interface StorageOptions {
  storageKey?: string;
}

const STORAGE_KEY = 'discord_manager_user_data';

export const createDefaultUserData = (): UserDataStore => ({
  version: CURRENT_USER_DATA_VERSION,
  favorites: [],
  nicknames: {},
  notes: {},
  widgetCache: {},
  lastFetchTimestamp: null,
  categories: [],
  serverCategories: {},
  servers: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const toStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (typeof entry === 'string') {
      acc[key] = entry;
    }
    return acc;
  }, {});
};

const toWidgetCache = (value: unknown): Record<string, WidgetCacheEntry> => {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, WidgetCacheEntry>>((acc, [key, entry]) => {
    if (!isRecord(entry)) {
      return acc;
    }
    const instantInvite = typeof entry.instantInvite === 'string' ? entry.instantInvite : null;
    const presenceCount = typeof entry.presenceCount === 'number' ? entry.presenceCount : null;
    const lastCached = typeof entry.lastCached === 'string' ? entry.lastCached : null;
    acc[key] = { instantInvite, presenceCount, lastCached };
    return acc;
  }, {});
};

const toCategoryDefinitions = (value: unknown): CategoryDefinition[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CategoryDefinition =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.order === 'number',
  );
};

const toNullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const toNullableCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const toMembershipSnapshot = (value: unknown): MembershipSnapshot | null => {
  if (!isRecord(value) || typeof value.capturedAt !== 'string') return null;
  return {
    joinedAt: toNullableString(value.joinedAt),
    nickname: toNullableString(value.nickname),
    roleCount: toNullableCount(value.roleCount) ?? 0,
    capturedAt: value.capturedAt,
  };
};

const toInviteSnapshot = (value: unknown): InviteSnapshot | null => {
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.capturedAt !== 'string') return null;
  // Imported files are untrusted: only keep invites that validate as Discord invite URLs.
  const url = normalizeInviteUrl(value.url);
  if (!url) return null;
  const source: InviteSource = value.source === 'widget' ? 'widget' : 'manual';
  return { url, source, capturedAt: value.capturedAt };
};

const toServerSnapshots = (value: unknown): Record<string, ServerSnapshot> => {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, ServerSnapshot>>((acc, [key, entry]) => {
    if (!isRecord(entry)) return acc;
    acc[key] = {
      id: key,
      name: toNullableString(entry.name),
      icon: toNullableString(entry.icon),
      banner: toNullableString(entry.banner),
      owner: entry.owner === true,
      features: toStringArray(entry.features),
      firstSeenAt: toNullableString(entry.firstSeenAt),
      lastSeenAt: toNullableString(entry.lastSeenAt),
      approximateMemberCount: toNullableCount(entry.approximateMemberCount),
      approximatePresenceCount: toNullableCount(entry.approximatePresenceCount),
      membership: toMembershipSnapshot(entry.membership),
      invite: toInviteSnapshot(entry.invite),
      savedAt: toNullableString(entry.savedAt),
      departedAt: toNullableString(entry.departedAt),
      departureReason: toNullableString(entry.departureReason),
    };
    return acc;
  }, {});
};

const sanitizeUserData = (raw: Record<string, unknown>): UserDataStore => ({
  version: typeof raw.version === 'number' ? raw.version : 1,
  favorites: toStringArray(raw.favorites),
  nicknames: toStringRecord(raw.nicknames),
  notes: toStringRecord(raw.notes),
  widgetCache: toWidgetCache(raw.widgetCache),
  lastFetchTimestamp: typeof raw.lastFetchTimestamp === 'string' ? raw.lastFetchTimestamp : null,
  categories: toCategoryDefinitions(raw.categories),
  serverCategories: toStringRecord(raw.serverCategories),
  servers: toServerSnapshots(raw.servers),
});

const resolveStorageKey = (options?: StorageOptions): string => options?.storageKey ?? STORAGE_KEY;

const migrateUserData = (data: UserDataStore): UserDataStore => {
  if (data.version > CURRENT_USER_DATA_VERSION) {
    throw new UnsupportedUserDataVersionError(data.version);
  }
  let migrated = data;
  if (migrated.version < 2) {
    migrated = {
      ...migrated,
      version: 2,
      categories: migrated.categories ?? [],
      serverCategories: migrated.serverCategories ?? {},
    };
  }
  if (migrated.version < 3) {
    migrated = {
      ...migrated,
      version: 3,
      servers: migrated.servers ?? {},
    };
  }
  return migrated;
};

export const unsupportedBackupKey = (options?: StorageOptions): string =>
  `${resolveStorageKey(options)}_unsupported_backup`;

/** Backup slots: the base key, then `_2`, `_3`, … so a later newer payload never replaces an earlier one. */
const unsupportedBackupSlot = (options: StorageOptions | undefined, index: number): string =>
  index === 1 ? unsupportedBackupKey(options) : `${unsupportedBackupKey(options)}_${index}`;

const backupUnsupportedPayload = (payload: string, options?: StorageOptions): void => {
  for (let index = 1; ; index += 1) {
    const key = unsupportedBackupSlot(options, index);
    const existing = localStorage.getItem(key);
    if (existing === payload) return;
    if (existing === null) {
      localStorage.setItem(key, payload);
      return;
    }
  }
};

export interface UnsupportedBackup {
  key: string;
  payload: string;
  version: number | null;
}

/** User data from a newer app version that loadUserData preserved instead of loading. */
export const listUnsupportedBackups = (options?: StorageOptions): UnsupportedBackup[] => {
  const backups: UnsupportedBackup[] = [];
  try {
    for (let index = 1; ; index += 1) {
      const key = unsupportedBackupSlot(options, index);
      const payload = localStorage.getItem(key);
      if (payload === null) break;
      let version: number | null = null;
      try {
        const parsed: unknown = JSON.parse(payload);
        version = isRecord(parsed) && typeof parsed.version === 'number' ? parsed.version : null;
      } catch {
        version = null;
      }
      backups.push({ key, payload, version });
    }
  } catch {
    // Storage unavailable: nothing to report.
  }
  return backups;
};

export const discardUnsupportedBackups = (options?: StorageOptions): void => {
  for (const backup of listUnsupportedBackups(options)) {
    localStorage.removeItem(backup.key);
  }
};

export const loadUserData = (options?: StorageOptions): UserDataStore => {
  try {
    const stored = localStorage.getItem(resolveStorageKey(options));
    if (!stored) {
      return createDefaultUserData();
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed)) {
      return createDefaultUserData();
    }
    if (typeof parsed.version === 'number' && parsed.version > CURRENT_USER_DATA_VERSION) {
      // Data written by a newer app version: keep an untouched copy so falling back to
      // defaults (and the next save) cannot destroy it.
      backupUnsupportedPayload(stored, options);
      throw new UnsupportedUserDataVersionError(parsed.version);
    }
    return migrateUserData(sanitizeUserData(parsed));
  } catch (error) {
    console.error('Failed to load user data', error);
    return createDefaultUserData();
  }
};

export const saveUserData = (data: UserDataStore, options?: StorageOptions): void => {
  localStorage.setItem(resolveStorageKey(options), JSON.stringify(data));
};

export const toggleFavorite = (
  data: UserDataStore,
  guildId: string,
  options?: StorageOptions,
): UserDataStore => {
  const isFavorite = data.favorites.includes(guildId);
  const favorites = isFavorite
    ? data.favorites.filter((id) => id !== guildId)
    : [...data.favorites, guildId];
  const next = { ...data, favorites };
  saveUserData(next, options);
  return next;
};

export const updateNickname = (
  data: UserDataStore,
  guildId: string,
  nickname: string,
  options?: StorageOptions,
): UserDataStore => {
  const trimmed = nickname.trim();
  const nextNicknames = { ...data.nicknames };
  if (trimmed.length > 0) {
    nextNicknames[guildId] = trimmed;
  } else {
    delete nextNicknames[guildId];
  }
  const next = { ...data, nicknames: nextNicknames };
  saveUserData(next, options);
  return next;
};

export const updateNotes = (
  data: UserDataStore,
  guildId: string,
  notes: string,
  options?: StorageOptions,
): UserDataStore => {
  const trimmed = notes.trim();
  const nextNotes = { ...data.notes };
  if (trimmed.length > 0) {
    nextNotes[guildId] = trimmed;
  } else {
    delete nextNotes[guildId];
  }
  const next = { ...data, notes: nextNotes };
  saveUserData(next, options);
  return next;
};

export const updateWidgetCache = (
  data: UserDataStore,
  guildId: string,
  entry: WidgetCacheEntry,
  options?: StorageOptions,
): UserDataStore => {
  const next = {
    ...data,
    widgetCache: {
      ...data.widgetCache,
      [guildId]: entry,
    },
  };
  saveUserData(next, options);
  return next;
};

export const clearWidgetCache = (data: UserDataStore, options?: StorageOptions): UserDataStore => {
  const next = { ...data, widgetCache: {} };
  saveUserData(next, options);
  return next;
};

export const updateLastFetchTimestamp = (
  data: UserDataStore,
  timestamp: string | null,
  options?: StorageOptions,
): UserDataStore => {
  const next = { ...data, lastFetchTimestamp: timestamp };
  saveUserData(next, options);
  return next;
};

export const exportUserData = (data: UserDataStore): string => {
  return JSON.stringify(data, null, 2);
};

const isValidUserData = (value: unknown): value is UserDataStore => {
  if (!isRecord(value)) return false;
  if (typeof value.version !== 'number') return false;
  if (!Array.isArray(value.favorites)) return false;
  if (!isRecord(value.nicknames)) return false;
  if (!isRecord(value.notes)) return false;
  if (!isRecord(value.widgetCache)) return false;
  // lastFetchTimestamp is optional for backwards compatibility
  if (value.lastFetchTimestamp !== undefined && value.lastFetchTimestamp !== null && typeof value.lastFetchTimestamp !== 'string') return false;
  // categories and serverCategories are optional (v1 compat); servers is optional (v2 compat)
  if (value.servers !== undefined && !isRecord(value.servers)) return false;
  return true;
};

export const importUserData = (raw: unknown, options?: StorageOptions): UserDataStore => {
  if (!isValidUserData(raw)) {
    throw new Error('Invalid user data format');
  }

  // Throws UnsupportedUserDataVersionError before anything is persisted.
  const sanitized: UserDataStore = migrateUserData(sanitizeUserData(raw as unknown as Record<string, unknown>));
  saveUserData(sanitized, options);
  return sanitized;
};

export const addCategory = (
  data: UserDataStore,
  name: string,
  options?: StorageOptions,
): UserDataStore => {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return data;
  const isDuplicate = data.categories.some(
    (cat) => cat.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (isDuplicate) return data;
  const maxOrder = data.categories.reduce((max, cat) => Math.max(max, cat.order), -1);
  const newCategory: CategoryDefinition = {
    id: crypto.randomUUID(),
    name: trimmed,
    order: maxOrder + 1,
  };
  const next = { ...data, categories: [...data.categories, newCategory] };
  saveUserData(next, options);
  return next;
};

export const updateCategory = (
  data: UserDataStore,
  categoryId: string,
  name: string,
  options?: StorageOptions,
): UserDataStore => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return data;
  if (trimmed.length > 50) return data;
  const index = data.categories.findIndex((cat) => cat.id === categoryId);
  if (index < 0) return data;
  const isDuplicate = data.categories.some(
    (cat) => cat.id !== categoryId && cat.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (isDuplicate) return data;
  const categories = data.categories.map((cat) =>
    cat.id === categoryId ? { ...cat, name: trimmed } : cat,
  );
  const next = { ...data, categories };
  saveUserData(next, options);
  return next;
};

export const deleteCategory = (
  data: UserDataStore,
  categoryId: string,
  options?: StorageOptions,
): UserDataStore => {
  const categories = data.categories.filter((cat) => cat.id !== categoryId);
  const serverCategories = { ...data.serverCategories };
  for (const [guildId, catId] of Object.entries(serverCategories)) {
    if (catId === categoryId) {
      delete serverCategories[guildId];
    }
  }
  const next = { ...data, categories, serverCategories };
  saveUserData(next, options);
  return next;
};

export const moveCategory = (
  data: UserDataStore,
  categoryId: string,
  direction: 'up' | 'down',
  options?: StorageOptions,
): UserDataStore => {
  const sorted = [...data.categories].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((cat) => cat.id === categoryId);
  if (index < 0) return data;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= sorted.length) return data;

  const current = sorted[index];
  const target = sorted[targetIndex];
  const categories = data.categories.map((cat) => {
    if (cat.id === current.id) return { ...cat, order: target.order };
    if (cat.id === target.id) return { ...cat, order: current.order };
    return cat;
  });
  const next = { ...data, categories };
  saveUserData(next, options);
  return next;
};

export const assignServerToCategory = (
  data: UserDataStore,
  guildId: string,
  categoryId: string | null,
  options?: StorageOptions,
): UserDataStore => {
  const serverCategories = { ...data.serverCategories };
  if (categoryId === null) {
    delete serverCategories[guildId];
  } else {
    serverCategories[guildId] = categoryId;
  }
  const next = { ...data, serverCategories };
  saveUserData(next, options);
  return next;
};

// --- Server snapshots ---

/** Guild fields observed in a guild-list response (structurally compatible with ApiGuild). */
export interface ObservedGuild {
  id: string;
  name: string;
  icon?: string | null;
  banner?: string | null;
  owner?: boolean;
  features?: string[];
  approximate_member_count?: number | null;
  approximate_presence_count?: number | null;
}

const collectAnnotatedGuildIds = (data: UserDataStore): string[] => {
  const ids = new Set<string>([
    ...data.favorites,
    ...Object.keys(data.nicknames),
    ...Object.keys(data.notes),
    ...Object.keys(data.serverCategories),
    ...Object.keys(data.widgetCache),
  ]);
  return [...ids];
};

const createUnknownDepartedSnapshot = (guildId: string, nowIso: string): ServerSnapshot => ({
  id: guildId,
  name: null,
  icon: null,
  banner: null,
  owner: false,
  features: [],
  firstSeenAt: null,
  lastSeenAt: null,
  approximateMemberCount: null,
  approximatePresenceCount: null,
  membership: null,
  invite: null,
  savedAt: null,
  departedAt: nowIso,
  departureReason: null,
});

const snapshotFromGuild = (
  guild: ObservedGuild,
  previous: ServerSnapshot | undefined,
  nowIso: string,
): ServerSnapshot => ({
  id: guild.id,
  name: guild.name,
  icon: guild.icon ?? null,
  banner: guild.banner ?? null,
  owner: guild.owner === true,
  features: Array.isArray(guild.features) ? [...guild.features] : [],
  firstSeenAt: previous?.firstSeenAt ?? nowIso,
  lastSeenAt: nowIso,
  // Edge-cached responses may predate count support; keep the last known counts then.
  approximateMemberCount: toNullableCount(guild.approximate_member_count) ?? previous?.approximateMemberCount ?? null,
  approximatePresenceCount:
    toNullableCount(guild.approximate_presence_count) ?? previous?.approximatePresenceCount ?? null,
  membership: previous?.membership ?? null,
  invite: previous?.invite ?? null,
  savedAt: previous?.savedAt ?? null,
  departedAt: null,
  departureReason: previous?.departureReason ?? null,
});

/**
 * Reconciles persisted server snapshots against a complete, successfully fetched guild list.
 *
 * Present guilds are upserted (clearing any departure), snapshots absent from the list are
 * marked departed, and annotation-only guild IDs become unknown-name departed records.
 * Pure: callers must only pass a list from a successful fetch and persist the result.
 */
export const reconcileServerSnapshots = (
  data: UserDataStore,
  guilds: readonly ObservedGuild[],
  nowIso: string,
): UserDataStore => {
  const servers: Record<string, ServerSnapshot> = { ...data.servers };
  const presentIds = new Set<string>();

  for (const guild of guilds) {
    presentIds.add(guild.id);
    servers[guild.id] = snapshotFromGuild(guild, data.servers[guild.id], nowIso);
  }

  for (const [guildId, snapshot] of Object.entries(servers)) {
    if (!presentIds.has(guildId) && snapshot.departedAt === null) {
      servers[guildId] = { ...snapshot, departedAt: nowIso };
    }
  }

  for (const guildId of collectAnnotatedGuildIds(data)) {
    if (!presentIds.has(guildId) && !servers[guildId]) {
      servers[guildId] = createUnknownDepartedSnapshot(guildId, nowIso);
    }
  }

  return { ...data, servers };
};

export interface ServerCapture {
  membership: MembershipSnapshot | null;
  invite: InviteSnapshot | null;
  departureReason: string | null;
}

/**
 * Saves (or refreshes) a "save for later" capture for a current server. Membership and
 * invite fall back to the previous capture when the new one has none, so a refresh that
 * cannot reach Discord never erases what was captured before.
 */
export const saveServerCapture = (
  data: UserDataStore,
  guild: ObservedGuild,
  capture: ServerCapture,
  nowIso: string,
  options?: StorageOptions,
): UserDataStore => {
  const previous = data.servers[guild.id];
  const base = snapshotFromGuild(guild, previous, nowIso);
  const reason = capture.departureReason?.trim() ?? '';
  const snapshot: ServerSnapshot = {
    ...base,
    membership: capture.membership ?? base.membership,
    invite: capture.invite ?? base.invite,
    savedAt: base.savedAt ?? nowIso,
    departureReason: reason.length > 0 ? reason : null,
  };
  const next = { ...data, servers: { ...data.servers, [guild.id]: snapshot } };
  saveUserData(next, options);
  return next;
};

export const updateDepartureReason = (
  data: UserDataStore,
  guildId: string,
  reason: string,
  options?: StorageOptions,
): UserDataStore => {
  const snapshot = data.servers[guildId];
  if (!snapshot) return data;
  const trimmed = reason.trim();
  const next = {
    ...data,
    servers: {
      ...data.servers,
      [guildId]: { ...snapshot, departureReason: trimmed.length > 0 ? trimmed : null },
    },
  };
  saveUserData(next, options);
  return next;
};

/**
 * Permanently removes a departed server's snapshot and every annotation keyed by its ID.
 * Refuses (returns data unchanged) for servers that are not departed.
 */
export const forgetServer = (
  data: UserDataStore,
  guildId: string,
  options?: StorageOptions,
): UserDataStore => {
  const snapshot = data.servers[guildId];
  if (!snapshot || snapshot.departedAt === null) return data;
  const without = <T>(record: Record<string, T>): Record<string, T> => {
    const copy = { ...record };
    delete copy[guildId];
    return copy;
  };
  const next: UserDataStore = {
    ...data,
    favorites: data.favorites.filter((id) => id !== guildId),
    nicknames: without(data.nicknames),
    notes: without(data.notes),
    widgetCache: without(data.widgetCache),
    serverCategories: without(data.serverCategories),
    servers: without(data.servers),
  };
  saveUserData(next, options);
  return next;
};
