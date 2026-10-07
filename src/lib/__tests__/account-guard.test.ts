import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

// state.ts reads localStorage at import time; give it a working one first.
vi.hoisted(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
});

import { AccountMismatchError, fetchGuildMember, fetchGuilds, type ApiGuild } from '../api';
import { activateAccount, deactivateAccount, watchAccountSwitch } from '../account';
import { syncGuildList } from '../guild-sync';
import { ACCOUNT_CHANGED_MESSAGE } from '../account-view';
import { applyGuildSyncOutcome } from '../hydrate';
import { initShowToast, setScreen } from '../render';
import { state, storageOptions } from '../state';
import { accountStorageKey, createDefaultUserData, reconcileServerSnapshots, saveUserData } from '../storage';

const A = '111';
const B = '222';
const T1 = '2026-10-01T10:00:00.000Z';
const guild = (id: string): ApiGuild => ({ id, name: `Server ${id}`, icon: null, banner: null, owner: false, features: [] });

const respondWith = (body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

const toast = { show: vi.fn(), dismiss: vi.fn() };

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  const appShell = document.getElementById('app-shell') as HTMLElement;
  initShowToast(toast as unknown as Parameters<typeof initShowToast>[0], appShell);
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  toast.show.mockClear();
  deactivateAccount();
  setScreen('app');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchGuilds', () => {
  it('returns the list only for the expected account, bypassing the browser cache', async () => {
    const fetchSpy = respondWith({ user_id: A, guilds: [guild('1')] });
    await expect(fetchGuilds(A)).resolves.toEqual([guild('1')]);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });

  it.each([
    ['another account', { user_id: B, guilds: [guild('9')] }, B],
    ['no user id', { guilds: [guild('9')] }, null],
  ])('refuses a list for %s', async (_label, body, actual) => {
    respondWith(body);
    const error = await fetchGuilds(A).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountMismatchError);
    expect(error).toMatchObject({ expected: A, actual });
  });

  it('revalidates member requests too', async () => {
    const fetchSpy = respondWith({ guild_id: '1' });
    await fetchGuildMember('1');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });
});

describe('a guild list for a different account', () => {
  const seedAccountA = () => {
    activateAccount(A, () => {});
    const data = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
    saveUserData({ ...data, notes: { '1': 'A note' } }, storageOptions);
    activateAccount(A, () => {});
  };

  it('is never reconciled or written', async () => {
    seedAccountA();
    const stored = localStorage.getItem(accountStorageKey(A));
    respondWith({ user_id: B, guilds: [guild('9')] });
    const setItem = vi.spyOn(localStorage, 'setItem');

    const outcome = await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions });

    expect(outcome.ok).toBe(false);
    expect(outcome.userData.servers['1'].departedAt).toBeNull();
    expect(outcome.userData.servers['9']).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(accountStorageKey(A))).toBe(stored);
    expect(localStorage.getItem(accountStorageKey(B))).toBeNull();
  });

  it('drops the loaded account and reloads once, then asks the user to reload', async () => {
    seedAccountA();
    respondWith({ user_id: B, guilds: [guild('9')] });
    const reload = vi.fn();

    applyGuildSyncOutcome(await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions }), {
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(state.accountId).toBeNull();
    expect(state.userData).toEqual(createDefaultUserData());
    expect(storageOptions.storageKey).toBeUndefined();

    // The reload did not settle it (same tab session): stop instead of looping.
    seedAccountA();
    applyGuildSyncOutcome(await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions }), {
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(document.getElementById('login-status')?.textContent).toBe(ACCOUNT_CHANGED_MESSAGE);
    expect(document.getElementById('app-shell')?.classList.contains('hidden')).toBe(true);
  });

  it('may reload again after a clean load', async () => {
    const reload = vi.fn();
    seedAccountA();
    respondWith({ user_id: B, guilds: [] });
    applyGuildSyncOutcome(await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions }), {
      reload,
    });
    seedAccountA();
    respondWith({ user_id: A, guilds: [guild('1'), guild('2')] });
    applyGuildSyncOutcome(await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions }));
    respondWith({ user_id: B, guilds: [] });
    applyGuildSyncOutcome(await syncGuildList(() => fetchGuilds(A), () => state.userData, { storageOptions }), {
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('watchAccountSwitch', () => {
  const announce = (newValue: string | null) =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'discord_manager_active_account', newValue }));

  it('fires only when another tab signs in as a different account', () => {
    const onSwitched = vi.fn();
    const stop = watchAccountSwitch(onSwitched);
    announce(B);
    expect(onSwitched).not.toHaveBeenCalled(); // signed out here: nothing to protect

    activateAccount(A, () => {});
    announce(A);
    announce(null);
    expect(onSwitched).not.toHaveBeenCalled();
    announce(B);
    expect(onSwitched).toHaveBeenCalledTimes(1);
    stop();
  });

  it('is announced when an account is activated', () => {
    activateAccount(B, () => {});
    expect(localStorage.getItem('discord_manager_active_account')).toBe(B);
  });
});
