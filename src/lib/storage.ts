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

export interface UserDataStore {
  version: number;
  favorites: string[];
  nicknames: Record<string, string>;
  notes: Record<string, string>;
  widgetCache: Record<string, WidgetCacheEntry>;
  lastFetchTimestamp: string | null;
  categories: CategoryDefinition[];
  serverCategories: Record<string, string>;
}

interface StorageOptions {
  storageKey?: string;
}

const STORAGE_KEY = 'discord_manager_user_data';

export const createDefaultUserData = (): UserDataStore => ({
  version: 2,
  favorites: [],
  nicknames: {},
  notes: {},
  widgetCache: {},
  lastFetchTimestamp: null,
  categories: [],
  serverCategories: {},
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

const resolveStorageKey = (options?: StorageOptions): string => options?.storageKey ?? STORAGE_KEY;

const migrateUserData = (data: UserDataStore): UserDataStore => {
  if (data.version < 2) {
    return {
      ...data,
      version: 2,
      categories: data.categories ?? [],
      serverCategories: data.serverCategories ?? {},
    };
  }
  return data;
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
    return migrateUserData({
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      favorites: toStringArray(parsed.favorites),
      nicknames: toStringRecord(parsed.nicknames),
      notes: toStringRecord(parsed.notes),
      widgetCache: toWidgetCache(parsed.widgetCache),
      lastFetchTimestamp: typeof parsed.lastFetchTimestamp === 'string' ? parsed.lastFetchTimestamp : null,
      categories: toCategoryDefinitions(parsed.categories),
      serverCategories: toStringRecord(parsed.serverCategories),
    });
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
  // categories and serverCategories are optional (v1 compat)
  return true;
};

export const importUserData = (raw: unknown, options?: StorageOptions): UserDataStore => {
  if (!isValidUserData(raw)) {
    throw new Error('Invalid user data format');
  }

  const sanitized: UserDataStore = migrateUserData({
    version: raw.version,
    favorites: toStringArray(raw.favorites),
    nicknames: toStringRecord(raw.nicknames),
    notes: toStringRecord(raw.notes),
    widgetCache: toWidgetCache(raw.widgetCache),
    lastFetchTimestamp: typeof raw.lastFetchTimestamp === 'string' ? raw.lastFetchTimestamp : null,
    categories: toCategoryDefinitions(raw.categories),
    serverCategories: toStringRecord(raw.serverCategories),
  });
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
