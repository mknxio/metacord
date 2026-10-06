import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadUserData,
  saveUserData,
  toggleFavorite,
  updateNickname,
  updateNotes,
  updateWidgetCache,
  clearWidgetCache,
  updateLastFetchTimestamp,
  exportUserData,
  importUserData,
  createDefaultUserData,
  addCategory,
  updateCategory,
  deleteCategory,
  moveCategory,
  assignServerToCategory,
  type UserDataStore,
  type WidgetCacheEntry,
} from '../storage';

/** Shape of a schema v2 payload (before server snapshots existed). */
type V2UserData = Omit<UserDataStore, 'servers'>;

// Use a unique key so tests don't collide with default storage
const TEST_KEY = '__test_storage_key__';
const opts = { storageKey: TEST_KEY };

// Create a simple in-memory localStorage mock since happy-dom's localStorage
// may not be fully functional in vitest's environment.
function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem(key: string) {
      return key in store ? store[key] : null;
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createLocalStorageMock());
});

describe('createDefaultUserData', () => {
  it('returns an object with correct shape and defaults', () => {
    const data = createDefaultUserData();
    expect(data).toEqual({
      version: 3,
      favorites: [],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
      categories: [],
      serverCategories: {},
      servers: {},
    });
  });

  it('returns a new object each time (not shared reference)', () => {
    const a = createDefaultUserData();
    const b = createDefaultUserData();
    expect(a).not.toBe(b);
    expect(a.favorites).not.toBe(b.favorites);
  });
});

describe('loadUserData', () => {
  it('returns default data when localStorage is empty', () => {
    const data = loadUserData(opts);
    expect(data).toEqual(createDefaultUserData());
  });

  it('loads valid stored v2 data and migrates it to v3 without losing fields', () => {
    const stored: V2UserData = {
      version: 2,
      favorites: ['guild1', 'guild2'],
      nicknames: { guild1: 'My Server' },
      notes: { guild1: 'Some notes' },
      widgetCache: {},
      lastFetchTimestamp: '2025-01-01T00:00:00Z',
      categories: [],
      serverCategories: {},
    };
    localStorage.setItem(TEST_KEY, JSON.stringify(stored));
    const data = loadUserData(opts);
    expect(data).toEqual({ ...stored, version: 3, servers: {} });
  });

  it('migrates v1 data through v2 to v3 on load', () => {
    const v1Data = {
      version: 1,
      favorites: ['guild1'],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
    };
    localStorage.setItem(TEST_KEY, JSON.stringify(v1Data));
    const data = loadUserData(opts);
    expect(data.version).toBe(3);
    expect(data.servers).toEqual({});
    expect(data.categories).toEqual([]);
    expect(data.serverCategories).toEqual({});
    expect(data.favorites).toEqual(['guild1']);
  });

  it('returns default data for corrupted JSON', () => {
    localStorage.setItem(TEST_KEY, 'not valid json{{{');
    const data = loadUserData(opts);
    expect(data).toEqual(createDefaultUserData());
  });

  it('returns default data for non-object JSON (string)', () => {
    localStorage.setItem(TEST_KEY, JSON.stringify('hello'));
    const data = loadUserData(opts);
    expect(data).toEqual(createDefaultUserData());
  });

  it('returns default data for array JSON', () => {
    localStorage.setItem(TEST_KEY, JSON.stringify([1, 2, 3]));
    const data = loadUserData(opts);
    expect(data).toEqual(createDefaultUserData());
  });

  it('sanitizes missing fields with defaults', () => {
    localStorage.setItem(TEST_KEY, JSON.stringify({ version: 2 }));
    const data = loadUserData(opts);
    expect(data.version).toBe(3);
    expect(data.favorites).toEqual([]);
    expect(data.nicknames).toEqual({});
    expect(data.notes).toEqual({});
    expect(data.widgetCache).toEqual({});
    expect(data.lastFetchTimestamp).toBeNull();
  });

  it('filters non-string values from favorites', () => {
    localStorage.setItem(
      TEST_KEY,
      JSON.stringify({
        version: 1,
        favorites: ['valid', 123, null, 'also_valid'],
      }),
    );
    const data = loadUserData(opts);
    expect(data.favorites).toEqual(['valid', 'also_valid']);
  });

  it('filters non-string values from nicknames', () => {
    localStorage.setItem(
      TEST_KEY,
      JSON.stringify({
        version: 1,
        nicknames: { a: 'valid', b: 123, c: null },
      }),
    );
    const data = loadUserData(opts);
    expect(data.nicknames).toEqual({ a: 'valid' });
  });

  it('sanitizes widget cache entries', () => {
    localStorage.setItem(
      TEST_KEY,
      JSON.stringify({
        version: 1,
        widgetCache: {
          g1: {
            instantInvite: 'https://discord.gg/abc',
            presenceCount: 42,
            lastCached: '2025-01-01',
          },
          g2: {
            instantInvite: 123, // wrong type
            presenceCount: 'not_a_number', // wrong type
            lastCached: null,
          },
          g3: 'not_an_object', // invalid entry
        },
      }),
    );
    const data = loadUserData(opts);
    expect(data.widgetCache.g1).toEqual({
      instantInvite: 'https://discord.gg/abc',
      presenceCount: 42,
      lastCached: '2025-01-01',
    });
    expect(data.widgetCache.g2).toEqual({
      instantInvite: null,
      presenceCount: null,
      lastCached: null,
    });
    expect(data.widgetCache.g3).toBeUndefined();
  });

  it('uses default storage key when no options provided', () => {
    const defaultKey = 'discord_manager_user_data';
    const stored: V2UserData = {
      version: 2,
      favorites: ['guild1'],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
      categories: [],
      serverCategories: {},
    };
    localStorage.setItem(defaultKey, JSON.stringify(stored));
    const data = loadUserData();
    expect(data.favorites).toEqual(['guild1']);
  });
});

describe('saveUserData', () => {
  it('saves data that can be loaded back', () => {
    const data = createDefaultUserData();
    data.favorites = ['guild1'];
    data.nicknames = { guild1: 'Test' };
    saveUserData(data, opts);

    const loaded = loadUserData(opts);
    expect(loaded).toEqual(data);
  });

  it('overwrites existing data', () => {
    const data1 = createDefaultUserData();
    data1.favorites = ['guild1'];
    saveUserData(data1, opts);

    const data2 = createDefaultUserData();
    data2.favorites = ['guild2'];
    saveUserData(data2, opts);

    const loaded = loadUserData(opts);
    expect(loaded.favorites).toEqual(['guild2']);
  });
});

describe('toggleFavorite', () => {
  it('adds a guild to favorites when not present', () => {
    const data = createDefaultUserData();
    const result = toggleFavorite(data, 'guild1', opts);
    expect(result.favorites).toContain('guild1');
  });

  it('removes a guild from favorites when already present', () => {
    const data = createDefaultUserData();
    data.favorites = ['guild1', 'guild2'];
    const result = toggleFavorite(data, 'guild1', opts);
    expect(result.favorites).not.toContain('guild1');
    expect(result.favorites).toContain('guild2');
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    toggleFavorite(data, 'guild1', opts);
    const loaded = loadUserData(opts);
    expect(loaded.favorites).toContain('guild1');
  });

  it('returns a new object (does not mutate input)', () => {
    const data = createDefaultUserData();
    const result = toggleFavorite(data, 'guild1', opts);
    expect(result).not.toBe(data);
    expect(data.favorites).toEqual([]);
  });
});

describe('updateNickname', () => {
  it('sets a nickname for a guild', () => {
    const data = createDefaultUserData();
    const result = updateNickname(data, 'guild1', 'My Server', opts);
    expect(result.nicknames.guild1).toBe('My Server');
  });

  it('updates an existing nickname', () => {
    const data = createDefaultUserData();
    data.nicknames = { guild1: 'Old Name' };
    const result = updateNickname(data, 'guild1', 'New Name', opts);
    expect(result.nicknames.guild1).toBe('New Name');
  });

  it('deletes nickname when set to empty string', () => {
    const data = createDefaultUserData();
    data.nicknames = { guild1: 'Old Name' };
    const result = updateNickname(data, 'guild1', '', opts);
    expect(result.nicknames.guild1).toBeUndefined();
  });

  it('trims whitespace from nickname', () => {
    const data = createDefaultUserData();
    const result = updateNickname(data, 'guild1', '  Trimmed  ', opts);
    expect(result.nicknames.guild1).toBe('Trimmed');
  });

  it('deletes nickname when only whitespace', () => {
    const data = createDefaultUserData();
    data.nicknames = { guild1: 'Old Name' };
    const result = updateNickname(data, 'guild1', '   ', opts);
    expect(result.nicknames.guild1).toBeUndefined();
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    updateNickname(data, 'guild1', 'Saved Name', opts);
    const loaded = loadUserData(opts);
    expect(loaded.nicknames.guild1).toBe('Saved Name');
  });
});

describe('updateNotes', () => {
  it('sets notes for a guild', () => {
    const data = createDefaultUserData();
    const result = updateNotes(data, 'guild1', 'Some notes', opts);
    expect(result.notes.guild1).toBe('Some notes');
  });

  it('updates existing notes', () => {
    const data = createDefaultUserData();
    data.notes = { guild1: 'Old notes' };
    const result = updateNotes(data, 'guild1', 'New notes', opts);
    expect(result.notes.guild1).toBe('New notes');
  });

  it('deletes notes when set to empty string', () => {
    const data = createDefaultUserData();
    data.notes = { guild1: 'Old notes' };
    const result = updateNotes(data, 'guild1', '', opts);
    expect(result.notes.guild1).toBeUndefined();
  });

  it('trims whitespace from notes', () => {
    const data = createDefaultUserData();
    const result = updateNotes(data, 'guild1', '  Trimmed  ', opts);
    expect(result.notes.guild1).toBe('Trimmed');
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    updateNotes(data, 'guild1', 'Persisted notes', opts);
    const loaded = loadUserData(opts);
    expect(loaded.notes.guild1).toBe('Persisted notes');
  });
});

describe('updateWidgetCache', () => {
  it('adds a new cache entry', () => {
    const data = createDefaultUserData();
    const entry: WidgetCacheEntry = {
      instantInvite: 'https://discord.gg/abc',
      presenceCount: 42,
      lastCached: '2025-01-01T00:00:00Z',
    };
    const result = updateWidgetCache(data, 'guild1', entry, opts);
    expect(result.widgetCache.guild1).toEqual(entry);
  });

  it('updates an existing cache entry', () => {
    const data = createDefaultUserData();
    data.widgetCache = {
      guild1: { instantInvite: null, presenceCount: 10, lastCached: null },
    };
    const entry: WidgetCacheEntry = {
      instantInvite: 'https://discord.gg/xyz',
      presenceCount: 100,
      lastCached: '2025-06-01T00:00:00Z',
    };
    const result = updateWidgetCache(data, 'guild1', entry, opts);
    expect(result.widgetCache.guild1).toEqual(entry);
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    const entry: WidgetCacheEntry = {
      instantInvite: null,
      presenceCount: 5,
      lastCached: '2025-01-01',
    };
    updateWidgetCache(data, 'guild1', entry, opts);
    const loaded = loadUserData(opts);
    expect(loaded.widgetCache.guild1).toEqual(entry);
  });
});

describe('clearWidgetCache', () => {
  it('clears all widget cache data', () => {
    const data = createDefaultUserData();
    data.widgetCache = {
      guild1: { instantInvite: null, presenceCount: 10, lastCached: null },
      guild2: { instantInvite: null, presenceCount: 20, lastCached: null },
    };
    const result = clearWidgetCache(data, opts);
    expect(result.widgetCache).toEqual({});
  });

  it('does not affect other fields', () => {
    const data = createDefaultUserData();
    data.favorites = ['guild1'];
    data.widgetCache = {
      guild1: { instantInvite: null, presenceCount: 10, lastCached: null },
    };
    const result = clearWidgetCache(data, opts);
    expect(result.favorites).toEqual(['guild1']);
    expect(result.widgetCache).toEqual({});
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    data.widgetCache = {
      guild1: { instantInvite: null, presenceCount: 10, lastCached: null },
    };
    saveUserData(data, opts);
    clearWidgetCache(data, opts);
    const loaded = loadUserData(opts);
    expect(loaded.widgetCache).toEqual({});
  });
});

describe('updateLastFetchTimestamp', () => {
  it('sets the timestamp', () => {
    const data = createDefaultUserData();
    const result = updateLastFetchTimestamp(data, '2025-06-01T12:00:00Z', opts);
    expect(result.lastFetchTimestamp).toBe('2025-06-01T12:00:00Z');
  });

  it('can clear the timestamp to null', () => {
    const data = createDefaultUserData();
    data.lastFetchTimestamp = '2025-01-01T00:00:00Z';
    const result = updateLastFetchTimestamp(data, null, opts);
    expect(result.lastFetchTimestamp).toBeNull();
  });

  it('persists changes to localStorage', () => {
    const data = createDefaultUserData();
    updateLastFetchTimestamp(data, '2025-06-01T12:00:00Z', opts);
    const loaded = loadUserData(opts);
    expect(loaded.lastFetchTimestamp).toBe('2025-06-01T12:00:00Z');
  });
});

describe('exportUserData', () => {
  it('returns valid JSON string', () => {
    const data = createDefaultUserData();
    data.favorites = ['guild1'];
    const exported = exportUserData(data);
    const parsed = JSON.parse(exported);
    expect(parsed.favorites).toEqual(['guild1']);
  });

  it('returns pretty-printed JSON with 2-space indentation', () => {
    const data = createDefaultUserData();
    const exported = exportUserData(data);
    expect(exported).toBe(JSON.stringify(data, null, 2));
  });
});

describe('importUserData', () => {
  it('imports valid user data', () => {
    const validData: V2UserData = {
      version: 2,
      favorites: ['guild1'],
      nicknames: { guild1: 'Test' },
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: '2025-01-01T00:00:00Z',
      categories: [],
      serverCategories: {},
    };
    const result = importUserData(validData, opts);
    expect(result.favorites).toEqual(['guild1']);
    expect(result.nicknames.guild1).toBe('Test');
  });

  it('throws for invalid data (non-object)', () => {
    expect(() => importUserData('not an object', opts)).toThrow('Invalid user data format');
  });

  it('throws for invalid data (missing version)', () => {
    expect(() => importUserData({ favorites: [], nicknames: {}, notes: {}, widgetCache: {} }, opts)).toThrow(
      'Invalid user data format',
    );
  });

  it('throws for invalid data (wrong field types)', () => {
    expect(() =>
      importUserData(
        { version: 1, favorites: 'not_array', nicknames: {}, notes: {}, widgetCache: {} },
        opts,
      ),
    ).toThrow('Invalid user data format');
  });

  it('throws for null input', () => {
    expect(() => importUserData(null, opts)).toThrow('Invalid user data format');
  });

  it('persists imported data to localStorage', () => {
    const validData: V2UserData = {
      version: 2,
      favorites: ['guild1'],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
      categories: [],
      serverCategories: {},
    };
    importUserData(validData, opts);
    const loaded = loadUserData(opts);
    expect(loaded.favorites).toEqual(['guild1']);
  });

  it('accepts data without lastFetchTimestamp (backwards compatibility)', () => {
    const data = {
      version: 1,
      favorites: [],
      nicknames: {},
      notes: {},
      widgetCache: {},
    };
    const result = importUserData(data, opts);
    expect(result.lastFetchTimestamp).toBeNull();
  });

  it('sanitizes imported data (filters non-string favorites)', () => {
    const data = {
      version: 1,
      favorites: ['valid', 123, null],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
    };
    const result = importUserData(data, opts);
    expect(result.favorites).toEqual(['valid']);
  });
});

describe('custom storage key option', () => {
  it('isolates data between different storage keys', () => {
    const key1 = { storageKey: '__test_key_1__' };
    const key2 = { storageKey: '__test_key_2__' };

    const data1 = createDefaultUserData();
    data1.favorites = ['guild_a'];
    saveUserData(data1, key1);

    const data2 = createDefaultUserData();
    data2.favorites = ['guild_b'];
    saveUserData(data2, key2);

    expect(loadUserData(key1).favorites).toEqual(['guild_a']);
    expect(loadUserData(key2).favorites).toEqual(['guild_b']);
  });
});

describe('addCategory', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1' });
  });

  it('adds a new category', () => {
    const data = createDefaultUserData();
    const result = addCategory(data, 'Gaming', opts);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].name).toBe('Gaming');
    expect(result.categories[0].order).toBe(0);
  });

  it('trims whitespace from name', () => {
    const data = createDefaultUserData();
    const result = addCategory(data, '  Gaming  ', opts);
    expect(result.categories[0].name).toBe('Gaming');
  });

  it('does nothing for empty name', () => {
    const data = createDefaultUserData();
    const result = addCategory(data, '   ', opts);
    expect(result.categories).toHaveLength(0);
  });

  it('assigns incrementing order values', () => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce('uuid-1')
        .mockReturnValueOnce('uuid-2'),
    });
    let data = createDefaultUserData();
    data = addCategory(data, 'First', opts);
    data = addCategory(data, 'Second', opts);
    expect(data.categories).toHaveLength(2);
    expect(data.categories[0].order).toBe(0);
    expect(data.categories[1].order).toBe(1);
  });

  it('persists to localStorage', () => {
    const data = createDefaultUserData();
    addCategory(data, 'Gaming', opts);
    const loaded = loadUserData(opts);
    expect(loaded.categories).toHaveLength(1);
  });
});

describe('updateCategory', () => {
  it('renames a category', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Old', order: 0 }];
    const result = updateCategory(data, 'cat-1', 'New Name', opts);
    expect(result.categories[0].name).toBe('New Name');
  });

  it('does nothing for empty name', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Old', order: 0 }];
    const result = updateCategory(data, 'cat-1', '', opts);
    expect(result.categories[0].name).toBe('Old');
  });

  it('does nothing for non-existent category', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Old', order: 0 }];
    const result = updateCategory(data, 'cat-999', 'New', opts);
    expect(result.categories[0].name).toBe('Old');
  });
});

describe('deleteCategory', () => {
  it('removes the category', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Gaming', order: 0 }];
    const result = deleteCategory(data, 'cat-1', opts);
    expect(result.categories).toHaveLength(0);
  });

  it('unassigns servers from deleted category', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Gaming', order: 0 }];
    data.serverCategories = { guild1: 'cat-1', guild2: 'cat-2' };
    const result = deleteCategory(data, 'cat-1', opts);
    expect(result.serverCategories.guild1).toBeUndefined();
    expect(result.serverCategories.guild2).toBe('cat-2');
  });

  it('persists to localStorage', () => {
    let data = createDefaultUserData();
    data.categories = [{ id: 'cat-1', name: 'Gaming', order: 0 }];
    saveUserData(data, opts);
    deleteCategory(data, 'cat-1', opts);
    const loaded = loadUserData(opts);
    expect(loaded.categories).toHaveLength(0);
  });
});

describe('moveCategory', () => {
  it('moves a category up', () => {
    let data = createDefaultUserData();
    data.categories = [
      { id: 'cat-1', name: 'First', order: 0 },
      { id: 'cat-2', name: 'Second', order: 1 },
    ];
    const result = moveCategory(data, 'cat-2', 'up', opts);
    const sorted = [...result.categories].sort((a, b) => a.order - b.order);
    expect(sorted[0].id).toBe('cat-2');
    expect(sorted[1].id).toBe('cat-1');
  });

  it('moves a category down', () => {
    let data = createDefaultUserData();
    data.categories = [
      { id: 'cat-1', name: 'First', order: 0 },
      { id: 'cat-2', name: 'Second', order: 1 },
    ];
    const result = moveCategory(data, 'cat-1', 'down', opts);
    const sorted = [...result.categories].sort((a, b) => a.order - b.order);
    expect(sorted[0].id).toBe('cat-2');
    expect(sorted[1].id).toBe('cat-1');
  });

  it('does nothing when moving first item up', () => {
    let data = createDefaultUserData();
    data.categories = [
      { id: 'cat-1', name: 'First', order: 0 },
      { id: 'cat-2', name: 'Second', order: 1 },
    ];
    const result = moveCategory(data, 'cat-1', 'up', opts);
    expect(result.categories).toEqual(data.categories);
  });

  it('does nothing when moving last item down', () => {
    let data = createDefaultUserData();
    data.categories = [
      { id: 'cat-1', name: 'First', order: 0 },
      { id: 'cat-2', name: 'Second', order: 1 },
    ];
    const result = moveCategory(data, 'cat-2', 'down', opts);
    expect(result.categories).toEqual(data.categories);
  });
});

describe('assignServerToCategory', () => {
  it('assigns a server to a category', () => {
    const data = createDefaultUserData();
    const result = assignServerToCategory(data, 'guild1', 'cat-1', opts);
    expect(result.serverCategories.guild1).toBe('cat-1');
  });

  it('unassigns a server (set to null)', () => {
    let data = createDefaultUserData();
    data.serverCategories = { guild1: 'cat-1' };
    const result = assignServerToCategory(data, 'guild1', null, opts);
    expect(result.serverCategories.guild1).toBeUndefined();
  });

  it('reassigns a server to a different category', () => {
    let data = createDefaultUserData();
    data.serverCategories = { guild1: 'cat-1' };
    const result = assignServerToCategory(data, 'guild1', 'cat-2', opts);
    expect(result.serverCategories.guild1).toBe('cat-2');
  });

  it('persists to localStorage', () => {
    const data = createDefaultUserData();
    assignServerToCategory(data, 'guild1', 'cat-1', opts);
    const loaded = loadUserData(opts);
    expect(loaded.serverCategories.guild1).toBe('cat-1');
  });
});

describe('import v1 data with categories migration', () => {
  it('migrates imported v1 data to v3 with empty categories and servers', () => {
    const v1Data = {
      version: 1,
      favorites: ['guild1'],
      nicknames: { guild1: 'Test' },
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
    };
    const result = importUserData(v1Data, opts);
    expect(result.version).toBe(3);
    expect(result.servers).toEqual({});
    expect(result.categories).toEqual([]);
    expect(result.serverCategories).toEqual({});
    expect(result.favorites).toEqual(['guild1']);
  });

  it('preserves categories when importing v2 data', () => {
    const v2Data = {
      version: 2,
      favorites: [],
      nicknames: {},
      notes: {},
      widgetCache: {},
      lastFetchTimestamp: null,
      categories: [{ id: 'cat-1', name: 'Gaming', order: 0 }],
      serverCategories: { guild1: 'cat-1' },
    };
    const result = importUserData(v2Data, opts);
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].name).toBe('Gaming');
    expect(result.serverCategories.guild1).toBe('cat-1');
  });
});
