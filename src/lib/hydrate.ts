import { AccountMismatchError, AuthError } from './api';
import { clearAccountReloadGuard } from './account';
import { handleAccountChanged } from './account-view';
import type { GuildSyncOutcome } from './guild-sync';
import { render, setScreen, showToast } from './render';
import { state } from './state';

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
