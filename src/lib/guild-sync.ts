import type { ApiGuild } from './api';
import { reconcileServerSnapshots, saveUserData, type UserDataStore } from './storage';

export type GuildSyncOutcome =
  | { ok: true; guilds: ApiGuild[]; userData: UserDataStore }
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
  saveUserData(next, options.storageOptions);
  return { ok: true, guilds, userData: next };
};
