import type { ApiGuild } from './api';
import { reconcileServerSnapshots, saveUserData, type UserDataStore } from './storage';

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
 * imports or edits made in the meantime.
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

  const nowIso = options.now?.() ?? new Date().toISOString();
  const next = reconcileServerSnapshots(getUserData(), guilds, nowIso);
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
 * Reconciles freshly imported user data against the guild list already loaded this
 * session, so imported history (orphan annotations, snapshots for servers left on another
 * device) shows up without a reload. `loadedGuilds` is null when no list has loaded
 * successfully yet; reconciling then would mark every server departed, so the imported
 * data is returned unchanged and the next successful load reconciles it.
 */
export const reconcileImportedUserData = (
  imported: UserDataStore,
  loadedGuilds: ApiGuild[] | null,
  nowIso: string,
  storageOptions?: { storageKey?: string },
): UserDataStore => {
  if (loadedGuilds === null) return imported;
  const next = reconcileServerSnapshots(imported, loadedGuilds, nowIso);
  saveUserData(next, storageOptions);
  return next;
};
