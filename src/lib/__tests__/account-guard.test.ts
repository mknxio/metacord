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

import { AccountMismatchError, fetchGuildMember, fetchGuilds, type ApiGuild, type ApiUser } from '../api';
import { activateAccount, currentAccountEpoch, deactivateAccount, isAccountCurrent, watchAccountSwitch } from '../account';
import { StaleAccountError, syncGuildList } from '../guild-sync';
import { ACCOUNT_CHANGED_MESSAGE } from '../account-view';
import { applyGuildSyncOutcome, verifyAndActivateAccount } from '../hydrate';
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
    const fetchSpy = respondWith({ user_id: A, guild_id: '1' });
    await fetchGuildMember('1', A);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });

  it.each([
    ['another account', { user_id: B, guild_id: '1', nickname: 'B nick' }, B],
    ['no user id', { guild_id: '1', nickname: 'B nick' }, null],
  ])('refuses member details for %s', async (_label, body, actual) => {
    respondWith(body);
    const error = await fetchGuildMember('1', A).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountMismatchError);
    expect(error).toMatchObject({ expected: A, actual });
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

describe('a guild list that resolves after the account changed', () => {
  it('is dropped without reconciling or writing', async () => {
    activateAccount(A, () => {});
    saveUserData(reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1), storageOptions);
    activateAccount(A, () => {});
    const epoch = currentAccountEpoch();
    let resolveFetch: (guilds: ApiGuild[]) => void = () => {};
    const pending = syncGuildList(
      () => new Promise<ApiGuild[]>((resolve) => (resolveFetch = resolve)),
      () => state.userData,
      { storageOptions, isCurrent: () => isAccountCurrent(epoch) },
    );
    activateAccount(B, () => {});
    const setItem = vi.spyOn(localStorage, 'setItem');
    resolveFetch([guild('9')]);
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.error).toBeInstanceOf(StaleAccountError);
    expect(setItem).not.toHaveBeenCalled();
    applyGuildSyncOutcome(outcome);
    expect(state.accountId).toBe(B);
    expect(state.guilds).toEqual([]);
  });
});

describe('verifyAndActivateAccount', () => {
  const CLAIM_KEY = 'discord_manager_active_account';
  const user = (id: string): ApiUser => ({ id, username: `user-${id}`, avatar: null });
  const deferred = () => {
    let resolve: (value: ApiUser) => void = () => {};
    const promise = new Promise<ApiUser>((done) => (resolve = done));
    return { promise, resolve };
  };

  beforeEach(() => {
    localStorage.setItem(accountStorageKey(A), JSON.stringify({ ...createDefaultUserData(), notes: { '1': 'A secret' } }));
    localStorage.setItem(CLAIM_KEY, A);
  });

  it('re-verifies instead of activating a stale identity when another tab claims an account meanwhile', async () => {
    const first = deferred();
    const fetchIdentity = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(user(B));
    const getItem = vi.spyOn(localStorage, 'getItem');

    const pending = verifyAndActivateAccount(fetchIdentity, () => {});
    // Another tab signs in as B (the shared cookie is now B's) before A's answer arrives.
    localStorage.setItem(CLAIM_KEY, B);
    window.dispatchEvent(new StorageEvent('storage', { key: CLAIM_KEY, newValue: B }));
    first.resolve(user(A));
    const result = await pending;

    expect(fetchIdentity).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'active', me: { id: B } });
    expect(state.accountId).toBe(B);
    expect(state.userData.notes).toEqual({});
    expect(getItem.mock.calls.map(([key]) => key)).not.toContain(accountStorageKey(A));
    expect(localStorage.getItem(CLAIM_KEY)).toBe(B);
  });

  it('activates the verified account when no other claim appeared', async () => {
    localStorage.setItem(CLAIM_KEY, B);
    const result = await verifyAndActivateAccount(vi.fn().mockResolvedValue(user(A)), () => {});
    expect(result).toMatchObject({ status: 'active' });
    expect(state.accountId).toBe(A);
    expect(state.userData.notes).toEqual({ '1': 'A secret' });
    expect(localStorage.getItem(CLAIM_KEY)).toBe(A);
  });

  it('gives up without activating anything when claims keep changing', async () => {
    let claim = 0;
    const fetchIdentity = vi.fn(async () => {
      claim += 1;
      localStorage.setItem(CLAIM_KEY, `9${claim}`);
      return user(A);
    });
    const result = await verifyAndActivateAccount(fetchIdentity, () => {}, 3);
    expect(result).toEqual({ status: 'unsettled' });
    expect(fetchIdentity).toHaveBeenCalledTimes(3);
    expect(state.accountId).toBeNull();
    expect(localStorage.getItem(CLAIM_KEY)).toBe('93');
  });

  it('stops when the page was invalidated while identity loaded', async () => {
    const first = deferred();
    const pending = verifyAndActivateAccount(() => first.promise, () => {});
    deactivateAccount();
    first.resolve(user(A));
    expect(await pending).toEqual({ status: 'superseded' });
    expect(state.accountId).toBeNull();
  });
});
