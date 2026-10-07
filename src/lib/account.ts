import { accountStorageKey, createDefaultUserData, loadUserData, watchPersistedUserData, type UserDataStore } from './storage';
import { state, storageOptions } from './state';

let stopWatching: (() => void) | null = null;

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
