import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApiGuild } from '../api';
import { renderUnsupportedDataNotice } from '../data-notice';
import { syncGuildList } from '../guild-sync';
import {
  createDefaultUserData,
  isUserDataWriteBlocked,
  listUnpreservedPayloads,
  listUnsupportedBackups,
  releaseUnpreservedPayload,
  loadUserData,
  reconcileServerSnapshots,
  saveUserData,
  watchPersistedUserData,
  type UserDataStore,
} from '../storage';

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
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

/** What this tab holds after boot: the store it loaded (and therefore last synced). */
const bootTab = (storageKey: string): UserDataStore => {
  const options = { storageKey };
  const seeded = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
  localStorage.setItem(storageKey, JSON.stringify({ ...seeded, notes: { '1': 'old note' } }));
  return loadUserData(options);
};

/** Another tab saving the whole store: localStorage changes without this tab writing it. */
const otherTabSaves = (storageKey: string, data: UserDataStore): string => {
  const payload = JSON.stringify(data);
  localStorage.setItem(storageKey, payload);
  return payload;
};

const dispatchStorageEvent = (key: string | null): void => {
  window.dispatchEvent(new StorageEvent('storage', { key }));
};

describe('guild sync racing another tab', () => {
  it('keeps edits another tab saved while the guild list was loading', async () => {
    const key = '__test_cross_tab_race__';
    const thisTab = bootTab(key);
    let resolveFetch: (guilds: ApiGuild[]) => void = () => {};
    const pending = syncGuildList(
      () => new Promise<ApiGuild[]>((resolve) => (resolveFetch = resolve)),
      () => thisTab,
      { now: () => T2, storageOptions: { storageKey: key } },
    );

    // The other tab edits a note and a favorite while this tab waits.
    otherTabSaves(key, { ...thisTab, notes: { '1': 'edited in another tab' }, favorites: ['2'] });
    resolveFetch([guild('1')]);
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    expect(outcome.userData.notes['1']).toBe('edited in another tab');
    expect(outcome.userData.favorites).toEqual(['2']);
    expect(outcome.userData.servers['2'].departedAt).toBe(T2);
    const persisted = loadUserData({ storageKey: key });
    expect(persisted.notes['1']).toBe('edited in another tab');
    expect(persisted.servers['2'].departedAt).toBe(T2);
  });

  it('reconciles this tab\'s copy when its own last save failed and storage is unchanged', async () => {
    const key = '__test_cross_tab_failed_save__';
    const thisTab = bootTab(key);
    // An edit this tab could not persist (e.g. quota): only memory holds it.
    const edited = { ...thisTab, notes: { '1': 'unsaved edit' } };
    const outcome = await syncGuildList(async () => [guild('1'), guild('2')], () => edited, {
      now: () => T2,
      storageOptions: { storageKey: key },
    });
    expect(outcome.userData.notes['1']).toBe('unsaved edit');
  });
});

describe('guild sync racing another tab\'s newer-version save', () => {
  const newer = JSON.stringify({ version: 99, notes: { '1': 'written by a newer version' } });

  const syncWhileOtherTabSavesNewer = async (key: string) => {
    const thisTab = bootTab(key);
    let resolveFetch: (guilds: ApiGuild[]) => void = () => {};
    const pending = syncGuildList(
      () => new Promise<ApiGuild[]>((resolve) => (resolveFetch = resolve)),
      () => thisTab,
      { now: () => T2, storageOptions: { storageKey: key } },
    );
    localStorage.setItem(key, newer);
    resolveFetch([guild('1')]);
    return pending;
  };

  it('backs the newer payload up before saving reconciled history', async () => {
    const key = '__test_cross_tab_race_newer__';
    const outcome = await syncWhileOtherTabSavesNewer(key);

    expect(outcome).toMatchObject({ ok: true, persisted: true });
    expect(listUnsupportedBackups({ storageKey: key }).map((backup) => backup.payload)).toEqual([newer]);
    const container = document.createElement('div');
    renderUnsupportedDataNotice(container, { storageKey: key });
    expect(container.textContent).toContain('schema v99');
  });

  it('pauses saving and keeps the payload in place when no backup fits', async () => {
    const key = '__test_cross_tab_race_newer_full__';
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((itemKey: string, value: string) => {
      if (itemKey.includes('_unsupported_backup')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(itemKey, value);
    });
    const outcome = await syncWhileOtherTabSavesNewer(key);

    expect(outcome).toMatchObject({ ok: true, persisted: false });
    expect(outcome.userData.servers['2'].departedAt).toBe(T2);
    expect(localStorage.getItem(key)).toBe(newer);
    expect(isUserDataWriteBlocked({ storageKey: key })).toBe(true);
    const container = document.createElement('div');
    renderUnsupportedDataNotice(container, { storageKey: key });
    expect(container.textContent).toContain('Saving is paused');
  });
});

describe('watchPersistedUserData', () => {
  it('adopts another tab\'s save to the active key', () => {
    const key = '__test_cross_tab_watch__';
    let current = bootTab(key);
    const onChange = vi.fn((data: UserDataStore) => (current = data));
    const stop = watchPersistedUserData(() => current, onChange, { storageKey: key });

    otherTabSaves(key, { ...current, notes: { '1': 'from another tab' } });
    dispatchStorageEvent(key);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(current.notes['1']).toBe('from another tab');

    // A later save here builds on the adopted data instead of overwriting it.
    saveUserData({ ...current, favorites: ['1'] }, { storageKey: key });
    expect(loadUserData({ storageKey: key })).toMatchObject({ notes: { '1': 'from another tab' }, favorites: ['1'] });
    stop();
  });

  it('ignores other keys, unchanged payloads and this tab\'s own saves', () => {
    const key = '__test_cross_tab_ignore__';
    const current = bootTab(key);
    const onChange = vi.fn();
    const stop = watchPersistedUserData(() => current, onChange, { storageKey: key });

    localStorage.setItem('some_other_key', 'x');
    dispatchStorageEvent('some_other_key');
    dispatchStorageEvent(null);
    dispatchStorageEvent(key);
    saveUserData({ ...current, favorites: ['1'] }, { storageKey: key });
    dispatchStorageEvent(key);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it('preserves another tab\'s newer-version data and reports it once', () => {
    const key = '__test_cross_tab_newer__';
    const current = bootTab(key);
    const onChange = vi.fn();
    const stop = watchPersistedUserData(() => current, onChange, { storageKey: key });

    const newer = JSON.stringify({ version: 99, notes: { '1': 'future' } });
    localStorage.setItem(key, newer);
    dispatchStorageEvent(key);
    dispatchStorageEvent(key);
    // Reported so the notice is refreshed; this tab keeps its own data.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(current);
    expect(listUnsupportedBackups({ storageKey: key }).map((backup) => backup.payload)).toEqual([newer]);
    expect(localStorage.getItem(key)).toBe(newer);
    stop();
  });

  it('stops listening when asked', () => {
    const key = '__test_cross_tab_stop__';
    const current = bootTab(key);
    const onChange = vi.fn();
    watchPersistedUserData(() => current, onChange, { storageKey: key })();
    otherTabSaves(key, { ...current, notes: { '1': 'later' } });
    dispatchStorageEvent(key);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// Storage full: backups never fit, so newer-version payloads are held in memory instead.
describe('another tab writing while saving is paused', () => {
  const first = JSON.stringify({ version: 99, notes: { '1': 'first newer payload' } });
  const second = JSON.stringify({ version: 99, notes: { '1': 'second newer payload' } });

  const bootBlocked = (key: string) => {
    const options = { storageKey: key };
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((itemKey: string, value: string) => {
      if (itemKey.includes('_unsupported_backup')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(itemKey, value);
    });
    localStorage.setItem(key, first);
    const current = loadUserData(options);
    expect(isUserDataWriteBlocked(options)).toBe(true);
    return { options, current };
  };

  const noticeFor = (options: { storageKey: string }, onWritesResumed = vi.fn()) => {
    const container = document.createElement('div');
    renderUnsupportedDataNotice(container, options, { onWritesResumed });
    const buttons = () => [...container.querySelectorAll('button')];
    return { container, buttons, onWritesResumed };
  };

  it('holds a different newer payload too, and downloading the first does not resume saving over it', () => {
    const { options, current } = bootBlocked('__test_blocked_second_newer__');
    const onChange = vi.fn();
    const stop = watchPersistedUserData(() => current, onChange, options);
    localStorage.setItem(options.storageKey, second);
    dispatchStorageEvent(options.storageKey);
    stop();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listUnpreservedPayloads(options).map((entry) => entry.payload)).toEqual([first, second]);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:held');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const notice = noticeFor(options);
    expect(notice.buttons().map((b) => b.textContent)).toEqual([
      'Download preserved data 1',
      'Download preserved data 2',
      'Discard preserved data',
    ]);

    notice.buttons()[0].click();
    expect(isUserDataWriteBlocked(options)).toBe(true);
    expect(notice.onWritesResumed).not.toHaveBeenCalled();
    expect(saveUserData(createDefaultUserData(), options)).toBe(false);
    expect(localStorage.getItem(options.storageKey)).toBe(second);
    expect(notice.container.textContent).toContain('Saving is paused');
  });

  it('checks the main key on save even before the storage event arrives', () => {
    const { options } = bootBlocked('__test_blocked_save_check__');
    localStorage.setItem(options.storageKey, second);
    releaseUnpreservedPayload(first, options);

    expect(saveUserData(createDefaultUserData(), options)).toBe(false);
    expect(localStorage.getItem(options.storageKey)).toBe(second);
    expect(listUnpreservedPayloads(options).map((entry) => entry.payload)).toEqual([second]);
  });

  it('adopts supported data another tab saved and keeps the held payload downloadable', () => {
    const { options, current } = bootBlocked('__test_blocked_supported__');
    let latest = current;
    const stop = watchPersistedUserData(() => latest, (data) => (latest = data), options);
    const fromOtherTab = { ...createDefaultUserData(), notes: { '1': 'saved by another tab' } };
    localStorage.setItem(options.storageKey, JSON.stringify(fromOtherTab));
    dispatchStorageEvent(options.storageKey);
    stop();

    expect(latest).toEqual(fromOtherTab);
    // The held payload is no longer in the main key, so this tab's saves cannot destroy it.
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(listUnpreservedPayloads(options).map((entry) => entry.payload)).toEqual([first]);
    const notice = noticeFor(options);
    expect(notice.buttons().map((b) => b.textContent)).toContain('Download preserved data');
    expect(notice.container.textContent).toContain('exists only in this page');
    expect(saveUserData({ ...latest, favorites: ['1'] }, options)).toBe(true);
    expect(loadUserData(options)).toMatchObject({ notes: { '1': 'saved by another tab' }, favorites: ['1'] });
  });

  it('releases only the exact payload it is given', () => {
    const { options } = bootBlocked('__test_blocked_release_exact__');
    releaseUnpreservedPayload(second, options);
    expect(isUserDataWriteBlocked(options)).toBe(true);

    localStorage.setItem(options.storageKey, second);
    saveUserData(createDefaultUserData(), options);
    releaseUnpreservedPayload(first, options);
    expect(isUserDataWriteBlocked(options)).toBe(true);
    expect(localStorage.getItem(options.storageKey)).toBe(second);

    releaseUnpreservedPayload(second, options);
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(listUnpreservedPayloads(options)).toEqual([]);
  });
});
