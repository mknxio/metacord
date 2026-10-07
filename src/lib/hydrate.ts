import { AccountMismatchError, AuthError, type ApiUser } from './api';
import {
  activateAccount,
  clearAccountReloadGuard,
  currentAccountEpoch,
  readActiveAccountClaim,
} from './account';
import { handleAccountChanged } from './account-view';
import { startCooldownTimer } from './fetch-orchestrator';
import { StaleAccountError, type GuildSyncOutcome } from './guild-sync';
import { render, setScreen, showToast } from './render';
import { state } from './state';
import type { UserDataStore } from './storage';

/**
 * Applies the result of loading the guild list at startup. A failed load (other than an
 * expired session) still renders the history stored in this browser, but never reconciles
 * against the missing list: current servers stay unknown rather than being marked departed.
 */
export const applyGuildSyncOutcome = (
  outcome: GuildSyncOutcome,
  hooks: { reload?: () => void } = {},
): void => {
  if (!outcome.ok) {
    if (outcome.error instanceof AuthError) {
      setScreen('login');
      return;
    }
    // Whatever invalidated the account already replaced the view.
    if (outcome.error instanceof StaleAccountError) return;
    if (outcome.error instanceof AccountMismatchError) {
      // The list belongs to another account (signed in from another tab): nothing was
      // reconciled or written. Drop this account's view and re-hydrate as the new one.
      handleAccountChanged(hooks.reload);
      return;
    }
    state.guildListError = true;
    render();
    showToast('Unable to load servers', { variant: 'error' });
    return;
  }
  clearAccountReloadGuard();
  state.guilds = outcome.guilds;
  state.guildListLoaded = true;
  state.guildListError = false;
  state.userData = outcome.userData;
  render();
  if (!outcome.persisted) {
    showToast('Server history could not be saved in this browser', { variant: 'error' });
  }
};

export type IdentityResult =
  | { status: 'active'; me: ApiUser }
  /** Something else (logout, an account change) invalidated the page while identity loaded. */
  | { status: 'superseded' }
  /** Other tabs kept switching accounts; identity could not be settled. */
  | { status: 'unsettled' };

/**
 * Verifies identity and only then activates that account's data. The session cookie is
 * shared, so if another tab claimed a different account while the identity request was
 * pending, its answer may describe the previous session: identity is verified again instead
 * of loading that account (or recording it as the active account over the newer claim).
 * Errors from `fetchIdentity` propagate to the caller.
 */
export const verifyAndActivateAccount = async (
  fetchIdentity: () => Promise<ApiUser>,
  onExternalChange: (data: UserDataStore) => void,
  maxAttempts = 3,
): Promise<IdentityResult> => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const epoch = currentAccountEpoch();
    const claimBefore = readActiveAccountClaim();
    const me = await fetchIdentity();
    if (currentAccountEpoch() !== epoch) return { status: 'superseded' };
    const claimNow = readActiveAccountClaim();
    if (claimNow !== claimBefore && claimNow !== me.id) continue;
    state.me = me.username;
    activateAccount(me.id, onExternalChange);
    // Fetch controls were set up before identity: apply this account's cooldown now.
    startCooldownTimer();
    return { status: 'active', me };
  }
  return { status: 'unsettled' };
};
