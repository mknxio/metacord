import { claimAccountReload, deactivateAccount } from './account';
import { startCooldownTimer } from './fetch-orchestrator';
import { render, setScreen } from './render';

export const ACCOUNT_CHANGED_MESSAGE = 'Your Discord account changed in another tab. Reload the page to continue.';

/** Overlay containers that can hold an account's personal data after they are closed. */
const PERSONAL_DATA_CONTAINERS = ['details-body', 'categories-list'];

/**
 * The single, synchronous path for every account invalidation (#9 per-account isolation):
 * logout, another tab signing in as someone else, a guild list for another account, and a
 * sign-in that could not settle. It drops the account's data, hides the app shell and closes
 * every overlay (setScreen runs closeAppOverlays), empties overlay contents and the data
 * notice, and shows the signed-out view with `message`, before any other code can run.
 */
export const invalidateAccountView = (message: string | null = null): void => {
  deactivateAccount();
  setScreen('login');
  for (const id of PERSONAL_DATA_CONTAINERS) {
    document.getElementById(id)?.replaceChildren();
  }
  const notice = document.getElementById('data-notice');
  notice?.replaceChildren();
  notice?.classList.add('hidden');
  render();
  // Drop the previous account's fetch cooldown from the controls.
  startCooldownTimer();
  const status = document.getElementById('login-status');
  if (status) status.textContent = message ?? '';
};

/** The session now belongs to another account: invalidate, then reload once to re-hydrate as it. */
export const handleAccountChanged = (reload: () => void = () => window.location.reload()): void => {
  invalidateAccountView(ACCOUNT_CHANGED_MESSAGE);
  if (claimAccountReload()) reload();
};
