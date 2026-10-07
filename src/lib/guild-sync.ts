import type { ApiGuild } from './api';
import {
  parseUserDataImport,
  readPersistedUserData,
  reconcileServerSnapshots,
  saveUserData,
  type UserDataStore,
} from './storage';

/**
 * `persisted: false` means the reconciled data was not written (quota, storage denied, or
 * saving paused for unpreserved newer-version data);
 * it is still returned so the session shows the list and history, but will not survive a reload.
 */
export type GuildSyncOutcome =
  | { ok: true; guilds: ApiGuild[]; userData: UserDataStore; persisted: boolean }
  | { ok: false; error: unknown; userData: UserDataStore };

interface GuildSyncOptions {
  now?: () => string;
  storageOptions?: { storageKey?: string };
  /** False once the account this sync started for is no longer active (see account.ts). */
  isCurrent?: () => boolean;
}

/** The account changed while the guild list loaded; its result was dropped unapplied. */
export class StaleAccountError extends Error {
  constructor() {
    super('The account changed while the guild list loaded');
    this.name = 'StaleAccountError';
  }
}

/**
 * Loads the guild list and, only when that load fully succeeds, reconciles server
 * snapshots (upserts, departures, orphan recovery) and persists the result.
 *
 * Departure detection compares against "everything the user is still in", so running it
 * on a failed, unauthorized, or malformed response would mark every server departed.
 *
 * User data is read through `getUserData` after the fetch settles: the UI stays usable
 * while the list loads, so reconciling a copy captured before the await would overwrite
 * imports or edits made in the meantime. If another tab saved in the meantime, its
 * persisted data is reconciled instead (see readPersistedUserData).
 */
export const syncGuildList = async (
  fetcher: () => Promise<ApiGuild[]>,
  getUserData: () => UserDataStore,
  options: GuildSyncOptions = {},
): Promise<GuildSyncOutcome> => {
  let guilds: ApiGuild[] | null = null;
  let error: unknown = null;
  try {
    const response = await fetcher();
    if (Array.isArray(response)) {
      guilds = response;
    } else {
      error = new Error('Malformed guild list response');
    }
  } catch (caught) {
    error = caught;
  }

  // Safety guard: never reconcile snapshots without a successful guild list.
  if (guilds === null) {
    return { ok: false, error, userData: getUserData() };
  }
  // Nor for an account that is no longer active: its data may now be another account's.
  if (options.isCurrent && !options.isCurrent()) {
    return { ok: false, error: new StaleAccountError(), userData: getUserData() };
  }

  const nowIso = options.now?.() ?? new Date().toISOString();
  // Another tab may have saved while the list loaded; reconcile its data, not a stale copy.
  const base = readPersistedUserData(getUserData(), options.storageOptions);
  const next = reconcileServerSnapshots(base, guilds, nowIso);
  let persisted: boolean;
  try {
    // False while saving is paused to protect unpreserved newer-version data.
    persisted = saveUserData(next, options.storageOptions);
  } catch (saveError) {
    // A storage failure must not hide a guild list that loaded fine.
    console.error('Failed to save server history', saveError);
    persisted = false;
  }
  return { ok: true, guilds, userData: next, persisted };
};

/**
 * Imports a user data file: validates it, reconciles it against the guild list already
 * loaded this session (so imported history such as orphan annotations or snapshots for
 * servers left on another device shows up without a reload), then saves once.
 *
 * `loadedGuilds` is null when no list has loaded successfully yet; reconciling then would
 * mark every server departed, so the imported data is saved as is and the next successful
 * load reconciles it. Any failure (invalid file, newer version, storage full) throws before
 * storage changes, so the caller keeps its pre-import state.
 */
export const importReconciledUserData = (
  raw: unknown,
  loadedGuilds: ApiGuild[] | null,
  nowIso: string,
  storageOptions?: { storageKey?: string },
): UserDataStore => {
  const imported = parseUserDataImport(raw);
  const next = loadedGuilds === null ? imported : reconcileServerSnapshots(imported, loadedGuilds, nowIso);
  saveUserData(next, storageOptions);
  return next;
};
