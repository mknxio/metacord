import { accountStorageKey, createDefaultUserData, loadUserData, watchPersistedUserData, type UserDataStore } from './storage';
import { state, storageOptions } from './state';

let stopWatching: (() => void) | null = null;

/** The account this browser's tabs last signed in as, so other tabs notice a switch. */
const ACTIVE_ACCOUNT_KEY = 'discord_manager_active_account';
/** Per-tab marker that this tab already reloaded once for an account change. */
const ACCOUNT_RELOAD_GUARD_KEY = 'discord_manager_account_reload';

/**
 * Switches this page to the signed-in account's data (#9 per-account isolation): its own
 * storage key, its stored data, and a watcher for other tabs' saves to that key only.
 * Nothing reads user data before this runs.
 */
export const activateAccount = (userId: string, onExternalChange: (data: UserDataStore) => void): void => {
  deactivateAccount();
  storageOptions.storageKey = accountStorageKey(userId);
  state.accountId = userId;
  state.userData = loadUserData(storageOptions);
  stopWatching = watchPersistedUserData(() => state.userData, onExternalChange, storageOptions);
  try {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, userId);
  } catch {
    // Best effort: other tabs still refuse guild lists for a different account.
  }
};

/**
 * Calls `onSwitched` when another tab signs in as a different account. The session cookie is
 * shared, so this tab's requests now act for that account and must not touch this one's data.
 */
export const watchAccountSwitch = (onSwitched: () => void): (() => void) => {
  const listener = (event: StorageEvent): void => {
    if (event.key !== ACTIVE_ACCOUNT_KEY || !event.newValue || state.accountId === null) return;
    if (event.newValue !== state.accountId) onSwitched();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};

/**
 * Drops this account's data and reloads so the page re-hydrates as whichever account the
 * session now belongs to. Reloads at most once per tab until a guild list loads cleanly
 * again (see clearAccountReloadGuard), so a persistent mismatch cannot loop; returns false
 * when it did not reload.
 */
export const reloadForAccountChange = (reload: () => void = () => window.location.reload()): boolean => {
  deactivateAccount();
  try {
    if (sessionStorage.getItem(ACCOUNT_RELOAD_GUARD_KEY)) return false;
    sessionStorage.setItem(ACCOUNT_RELOAD_GUARD_KEY, '1');
  } catch {
    return false;
  }
  reload();
  return true;
};

export const clearAccountReloadGuard = (): void => {
  try {
    sessionStorage.removeItem(ACCOUNT_RELOAD_GUARD_KEY);
  } catch {
    // Nothing to clear.
  }
};

/** Signs this page out of the account's data. Data at rest stays under that account's key. */
export const deactivateAccount = (): void => {
  stopWatching?.();
  stopWatching = null;
  delete storageOptions.storageKey;
  state.me = null;
  state.accountId = null;
  state.userData = createDefaultUserData();
  state.guilds = [];
  state.guildListLoaded = false;
  state.guildListError = false;
  state.selectionMode = false;
  state.selectedIds.clear();
};
