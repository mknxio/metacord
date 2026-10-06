import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthError, RateLimitError, type ApiGuild } from '../api';
import { syncGuildList } from '../guild-sync';
import {
  createDefaultUserData,
  loadUserData,
  reconcileServerSnapshots,
  saveUserData,
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
    expect(outcome.ok).toBe(true);
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
