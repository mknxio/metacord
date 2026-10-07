import { AuthError } from './api';
import type { GuildSyncOutcome } from './guild-sync';
import { render, setScreen, showToast } from './render';
import { state } from './state';

/**
 * Applies the result of loading the guild list at startup. A failed load (other than an
 * expired session) still renders the history stored in this browser, but never reconciles
 * against the missing list: current servers stay unknown rather than being marked departed.
 */
export const applyGuildSyncOutcome = (outcome: GuildSyncOutcome): void => {
  if (!outcome.ok) {
    if (outcome.error instanceof AuthError) {
      setScreen('login');
      return;
    }
    state.guildListError = true;
    render();
    showToast('Unable to load servers', { variant: 'error' });
    return;
  }
  state.guilds = outcome.guilds;
  state.guildListLoaded = true;
  state.guildListError = false;
  state.userData = outcome.userData;
  render();
  if (!outcome.persisted) {
    showToast('Server history could not be saved in this browser', { variant: 'error' });
  }
};
