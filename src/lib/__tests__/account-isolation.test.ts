import { describe, it, expect, beforeEach, vi } from 'vitest';

// Seed storage before state.ts is imported, and record every key read, so the test can
// prove nothing reads user data before identity is known.
const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  const reads: string[] = [];
  store.set('discord_manager_user_data', JSON.stringify({ version: 3, favorites: ['legacy'], nicknames: {}, notes: {}, widgetCache: {} }));
  store.set('discord_manager_user_data:111', JSON.stringify({ version: 3, favorites: ['a-fav'], nicknames: {}, notes: {}, widgetCache: {} }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      reads.push(key);
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  return { store, reads };
});

import { activateAccount, deactivateAccount } from '../account';
import { importReconciledUserData } from '../guild-sync';
import { state, storageOptions } from '../state';
import {
  accountStorageKey,
  createDefaultUserData,
  discardLegacyUserData,
  loadUserData,
  saveUserData,
  updateNotes,
} from '../storage';

const USER_DATA_PREFIX = 'discord_manager_user_data';
const A = '111';
const B = '222';
const noop = () => {};
const dispatchStorageEvent = (key: string) => window.dispatchEvent(new StorageEvent('storage', { key }));

describe('before identity is known', () => {
  // Runs first, against the state module exactly as importing it left it.
  it('reads no user data and has nowhere to write it', () => {
    expect(storage.reads.filter((key) => key.startsWith(USER_DATA_PREFIX))).toEqual([]);
    expect(state.accountId).toBeNull();
    expect(state.userData).toEqual(createDefaultUserData());
    expect(storageOptions.storageKey).toBeUndefined();
    expect(() => saveUserData(createDefaultUserData(), storageOptions)).toThrow('sign in first');
  });
});

describe('per-account isolation', () => {
  beforeEach(() => {
    deactivateAccount();
    storage.store.delete(accountStorageKey(B));
  });

  it('keeps each account\'s data invisible to the other', () => {
    activateAccount(A, noop);
    expect(state.userData.favorites).toEqual(['a-fav']);
    state.userData = updateNotes(state.userData, '9', 'note by A', storageOptions);

    activateAccount(B, noop);
    expect(state.userData.favorites).toEqual([]);
    expect(state.userData.notes).toEqual({});
    state.userData = updateNotes(state.userData, '9', 'note by B', storageOptions);

    expect(loadUserData({ storageKey: accountStorageKey(A) }).notes).toEqual({ '9': 'note by A' });
    expect(loadUserData({ storageKey: accountStorageKey(B) }).notes).toEqual({ '9': 'note by B' });
    activateAccount(A, noop);
    expect(state.userData.notes).toEqual({ '9': 'note by A' });
  });

  it('never surfaces the legacy unscoped data for any account', () => {
    activateAccount(B, noop);
    expect(state.userData.favorites).not.toContain('legacy');
  });

  it('clears in-memory data on logout and keeps it at rest', () => {
    activateAccount(A, noop);
    state.guilds = [{ id: '9', name: 'G', icon: null, banner: null, owner: false, features: [] }];
    state.guildListLoaded = true;
    deactivateAccount();

    expect(state.accountId).toBeNull();
    expect(state.userData).toEqual(createDefaultUserData());
    expect(state.guilds).toEqual([]);
    expect(state.guildListLoaded).toBe(false);
    expect(storageOptions.storageKey).toBeUndefined();
    expect(loadUserData({ storageKey: accountStorageKey(A) }).favorites).toEqual(['a-fav']);
  });

  it('watches only the active account\'s key, and nothing after logout', () => {
    const onChange = vi.fn();
    activateAccount(A, onChange);

    storage.store.set(accountStorageKey(B), JSON.stringify({ ...createDefaultUserData(), notes: { '1': 'B tab' } }));
    dispatchStorageEvent(accountStorageKey(B));
    expect(onChange).not.toHaveBeenCalled();

    storage.store.set(accountStorageKey(A), JSON.stringify({ ...createDefaultUserData(), notes: { '1': 'A tab' } }));
    dispatchStorageEvent(accountStorageKey(A));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].notes).toEqual({ '1': 'A tab' });

    deactivateAccount();
    storage.store.set(accountStorageKey(A), JSON.stringify({ ...createDefaultUserData(), notes: { '1': 'later' } }));
    dispatchStorageEvent(accountStorageKey(A));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('imports only into the signed-in account\'s key, and not at all when signed out', () => {
    const imported = { ...createDefaultUserData(), notes: { '5': 'imported' } };
    activateAccount(B, noop);
    const before = new Map(storage.store);
    importReconciledUserData(imported, null, '2026-10-07T00:00:00.000Z', storageOptions);
    const changed = [...storage.store.keys()].filter((key) => storage.store.get(key) !== before.get(key));
    expect(changed).toEqual([accountStorageKey(B)]);

    deactivateAccount();
    const signedOut = new Map(storage.store);
    expect(() => importReconciledUserData(imported, null, '2026-10-07T00:00:00.000Z', storageOptions)).toThrow(
      'sign in first',
    );
    expect(new Map(storage.store)).toEqual(signedOut);
  });
});

describe('discardLegacyUserData', () => {
  it('removes the unscoped key and its backups, and nothing else (#9, 2026-10-07)', () => {
    storage.store.set(USER_DATA_PREFIX, JSON.stringify({ version: 3, favorites: ['legacy'] }));
    storage.store.set(`${USER_DATA_PREFIX}_unsupported_backup`, '{"version":9}');
    storage.store.set(`${USER_DATA_PREFIX}_unsupported_backup_2`, '{"version":10}');
    storage.store.set(`${accountStorageKey(A)}_unsupported_backup`, '{"version":9}');
    storage.store.set('discord_manager_demo_user_data', '{"version":3}');
    const accountData = storage.store.get(accountStorageKey(A));

    discardLegacyUserData();

    expect(storage.store.has(USER_DATA_PREFIX)).toBe(false);
    expect(storage.store.has(`${USER_DATA_PREFIX}_unsupported_backup`)).toBe(false);
    expect(storage.store.has(`${USER_DATA_PREFIX}_unsupported_backup_2`)).toBe(false);
    expect(storage.store.get(accountStorageKey(A))).toBe(accountData);
    expect(storage.store.has(`${accountStorageKey(A)}_unsupported_backup`)).toBe(true);
    expect(storage.store.has('discord_manager_demo_user_data')).toBe(true);
  });
});

describe('accountStorageKey', () => {
  it('scopes keys by Discord user ID and rejects anything else', () => {
    expect(accountStorageKey(A)).toBe(`${USER_DATA_PREFIX}:111`);
    expect(() => accountStorageKey('')).toThrow();
    expect(() => accountStorageKey('../x')).toThrow();
  });
});
