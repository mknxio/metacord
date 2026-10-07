import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthError, RateLimitError, type ApiGuild } from '../api';
import { importReconciledUserData, syncGuildList } from '../guild-sync';
import {
  createDefaultUserData,
  loadUserData,
  reconcileServerSnapshots,
  saveUserData,
  UnsupportedUserDataVersionError,
  type UserDataStore,
} from '../storage';

const TEST_KEY = '__test_guild_sync_key__';
const storageOptions = { storageKey: TEST_KEY };
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';

function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createLocalStorageMock());
});

const guild = (id: string): ApiGuild => ({
  id,
  name: `Server ${id}`,
  icon: null,
  banner: null,
  owner: false,
  features: [],
  approximate_member_count: 10,
  approximate_presence_count: 2,
});

const seededData = () => {
  const reconciled = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
  // An annotation for a server left before snapshots existed (not yet recovered).
  const data = { ...reconciled, notes: { orphan: 'left long ago' } };
  saveUserData(data, storageOptions);
  return data;
};

describe('syncGuildList', () => {
  it('reconciles and persists snapshots after a successful fetch', async () => {
    const data = seededData();
    const outcome = await syncGuildList(async () => [guild('1')], () => data, { now: () => T2, storageOptions });
    expect(outcome).toMatchObject({ ok: true, persisted: true });
    expect(outcome.userData.servers['2'].departedAt).toBe(T2);
    expect(outcome.userData.servers['1'].lastSeenAt).toBe(T2);
    expect(outcome.userData.servers.orphan).toMatchObject({ name: null, departedAt: T2 });
    expect(loadUserData(storageOptions).servers['2'].departedAt).toBe(T2);
  });

  // Safety test for departure detection: a failed, unauthorized, rate-limited or
  // malformed guild-list load must never mark anything departed or recover orphans.
  it.each([
    ['network error', () => Promise.reject(new Error('Request failed: 500'))],
    ['unauthorized', () => Promise.reject(new AuthError())],
    ['rate limited', () => Promise.reject(new RateLimitError(30))],
    ['malformed response', () => Promise.resolve(undefined as unknown as ApiGuild[])],
  ])('leaves snapshots untouched when the guild list load fails (%s)', async (_label, fetcher) => {
    const data = seededData();
    const stored = localStorage.getItem(TEST_KEY);
    const outcome = await syncGuildList(fetcher, () => data, { now: () => T2, storageOptions });
    expect(outcome.ok).toBe(false);
    expect(outcome.userData).toBe(data);
    expect(outcome.userData.servers['1'].departedAt).toBeNull();
    expect(outcome.userData.servers['2'].departedAt).toBeNull();
    expect(outcome.userData.servers.orphan).toBeUndefined();
    expect(localStorage.getItem(TEST_KEY)).toBe(stored);
  });

  // A storage failure must not abort hydration: the fetched list still renders this session.
  it('returns the fetched list and reconciled history when saving them fails', async () => {
    const data = seededData();
    const stored = localStorage.getItem(TEST_KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const outcome = await syncGuildList(async () => [guild('1')], () => data, { now: () => T2, storageOptions });
    expect(outcome).toMatchObject({ ok: true, persisted: false, guilds: [guild('1')] });
    expect(outcome.userData.servers['2'].departedAt).toBe(T2);
    expect(outcome.userData.servers.orphan).toMatchObject({ name: null, departedAt: T2 });
    expect(localStorage.getItem(TEST_KEY)).toBe(stored);
  });

  it('reports history as not persisted while saving is paused for newer-version data', async () => {
    const pausedOptions = { storageKey: '__test_guild_sync_paused__' };
    const newer = JSON.stringify({ version: 9, notes: { '1': 'irreplaceable' } });
    localStorage.setItem(pausedOptions.storageKey, newer);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes('_unsupported_backup')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    const data = loadUserData(pausedOptions);
    const outcome = await syncGuildList(async () => [guild('1')], () => data, {
      now: () => T2,
      storageOptions: pausedOptions,
    });
    expect(outcome).toMatchObject({ ok: true, persisted: false });
    expect(outcome.userData.servers['1'].lastSeenAt).toBe(T2);
    expect(localStorage.getItem(pausedOptions.storageKey)).toBe(newer);
  });

  it('surfaces the original error so callers can route to login', async () => {
    const outcome = await syncGuildList(() => Promise.reject(new AuthError()), () => createDefaultUserData(), {
      storageOptions,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AuthError);
    }
  });

  it('reconciles the user data current when the fetch resolves, not a stale copy', async () => {
    let current: UserDataStore = seededData();
    let resolveFetch: (guilds: ApiGuild[]) => void = () => {};
    const fetcher = () =>
      new Promise<ApiGuild[]>((resolve) => {
        resolveFetch = resolve;
      });
    const pending = syncGuildList(fetcher, () => current, { now: () => T2, storageOptions });
    // An import or category edit lands while the guild list is still loading.
    current = { ...current, notes: { ...current.notes, '1': 'edited during load' } };
    resolveFetch([guild('1'), guild('2')]);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.userData.notes['1']).toBe('edited during load');
    expect(loadUserData(storageOptions).notes['1']).toBe('edited during load');
  });
});

describe('importReconciledUserData', () => {
  const v2Export = {
    version: 2,
    favorites: ['1'],
    nicknames: {},
    notes: { '1': 'still here', gone: 'left before history existed' },
    widgetCache: {},
    lastFetchTimestamp: null,
    categories: [],
    serverCategories: {},
  };

  it('recovers imported orphan annotations and snapshots current servers when a list is loaded', () => {
    const next = importReconciledUserData(v2Export, [guild('1')], T2, storageOptions);
    expect(next.servers['1']).toMatchObject({ name: 'Server 1', departedAt: null, lastSeenAt: T2 });
    expect(next.servers.gone).toMatchObject({ name: null, departedAt: T2 });
    expect(next.notes).toEqual(v2Export.notes);
    expect(loadUserData(storageOptions)).toEqual(next);
  });

  it('saves the import unreconciled when no guild list has loaded yet', () => {
    const next = importReconciledUserData(v2Export, null, T2, storageOptions);
    expect(next.servers).toEqual({});
    expect(next.notes).toEqual(v2Export.notes);
    expect(loadUserData(storageOptions)).toEqual(next);
  });

  it('saves exactly once, after reconciliation', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    importReconciledUserData(v2Export, [guild('1')], T2, storageOptions);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setItem.mock.calls[0][1]).servers.gone).toMatchObject({ departedAt: T2 });
  });

  it('leaves stored data untouched when the save fails', () => {
    const data = seededData();
    const stored = localStorage.getItem(TEST_KEY);
    // Only the reconciled store (larger: it adds snapshots) exceeds the quota.
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (Object.keys(JSON.parse(value).servers ?? {}).length > 0) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    expect(() => importReconciledUserData(v2Export, [guild('1')], T2, storageOptions)).toThrow('quota');
    expect(localStorage.getItem(TEST_KEY)).toBe(stored);
    expect(loadUserData(storageOptions)).toEqual(data);
  });

  it('rejects invalid and newer-version files without saving', () => {
    seededData();
    const stored = localStorage.getItem(TEST_KEY);
    expect(() => importReconciledUserData({ nope: true }, [guild('1')], T2, storageOptions)).toThrow(
      'Invalid user data format',
    );
    expect(() => importReconciledUserData({ ...v2Export, version: 99 }, [guild('1')], T2, storageOptions)).toThrow(
      UnsupportedUserDataVersionError,
    );
    expect(localStorage.getItem(TEST_KEY)).toBe(stored);
  });
});
