import { AuthError, fetchGuilds, fetchMe, type ApiUser } from './lib/api';
import { createModalController } from './components/modal';
import { createToastManager } from './components/toast';
import { getElement, isDemoMode, state, storageOptions } from './lib/state';
import { syncGuildList } from './lib/guild-sync';
import { applyGuildSyncOutcome } from './lib/hydrate';
import {
  initAccountMismatch,
  initDetailsModal,
  initSetScreen,
  initShowToast,
  initWidgetRateLimit,
  render,
  setScreen,
  showToast,
} from './lib/render';
import {
  fetchState,
  initFetchOrchestrator,
  startRateLimitTimer,
  stopCooldownTimer,
  stopRateLimitTimer,
} from './lib/fetch-orchestrator';
import { hydrateDemo, setupDemoMode } from './lib/demo';
import { renderUnsupportedDataNotice } from './lib/data-notice';
import {
  discardLegacyUserData,
  onNewerPayloadPreserved,
  saveUserData,
  watchPersistedUserData,
  type UserDataStore,
} from './lib/storage';
import { activateAccount, currentAccountEpoch, isAccountCurrent, watchAccountSwitch } from './lib/account';
import { handleAccountChanged } from './lib/account-view';
import { setupEvents } from './lib/events';

// --- Error boundary ---

const showErrorScreen = (): void => {
  const errorScreen = document.getElementById('error-screen');
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app-shell');

  if (errorScreen) {
    errorScreen.classList.remove('hidden');
    errorScreen.setAttribute('aria-hidden', 'false');
  }
  if (loginScreen) {
    loginScreen.classList.add('hidden');
    loginScreen.setAttribute('aria-hidden', 'true');
  }
  if (appShell) {
    appShell.classList.add('hidden');
    appShell.setAttribute('aria-hidden', 'true');
  }
};

window.onerror = (_message, _source, _lineno, _colno, error) => {
  console.error('Unhandled error:', error);
  showErrorScreen();
};

window.onunhandledrejection = (event: PromiseRejectionEvent) => {
  console.error('Unhandled promise rejection:', event.reason);
  showErrorScreen();
};

// --- Footer ---

const setFooterYear = (): void => {
  const footerYear = document.getElementById('footer-year');
  if (footerYear) {
    footerYear.textContent = `${new Date().getFullYear()}`;
  }
};

const setFooterBuildInfo = (): void => {
  const footerBuild = document.getElementById('footer-build');
  if (!footerBuild) {
    return;
  }
  const version = import.meta.env.VITE_APP_VERSION;
  const timestamp = import.meta.env.VITE_BUILD_TIMESTAMP;
  if (version && timestamp) {
    footerBuild.textContent = `[Build ${version}-${timestamp}]`;
  }
};

// --- Shared instances ---

const appShell = getElement<HTMLElement>('app-shell');
const toastRegion = getElement<HTMLElement>('toast-region');
const toast = createToastManager(toastRegion);

const importModal = createModalController(getElement('import-modal'));
const fetchModal = createModalController(getElement('fetch-modal'));
const detailsModal = createModalController(getElement('details-modal'));
const instructionsModal = createModalController(getElement('instructions-modal'));
const demoModal = createModalController(getElement('demo-modal'));
const categoriesModal = createModalController(getElement('categories-modal'));

// --- Initialize modules ---

initShowToast(toast, appShell);
initSetScreen(closeAppOverlays);
initDetailsModal(detailsModal);
initFetchOrchestrator(fetchModal);
initAccountMismatch(() => handleAccountChanged());
initWidgetRateLimit({
  isActive: () => fetchState.rateLimitUntil !== null && fetchState.rateLimitUntil > Date.now(),
  report: (retryAfterSeconds) => {
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
      startRateLimitTimer(retryAfterSeconds);
    }
  },
});

// --- Overlays ---

function closeAppOverlays(): void {
  fetchState.shouldStop = true;
  fetchState.inProgress = false;
  getElement<HTMLElement>('fetch-progress-inline').classList.add('hidden');
  stopCooldownTimer();
  stopRateLimitTimer();
  importModal.close();
  fetchModal.close();
  detailsModal.close();
  instructionsModal.close();
  demoModal.close();
  categoriesModal.close();
  toastRegion.replaceChildren();
}

// --- Newer-version data notice ---

function renderDataNotice(): void {
  renderUnsupportedDataNotice(getElement('data-notice'), storageOptions, {
    // Persist what changed while saving was paused for unpreserved newer-version data.
    onWritesResumed: () => {
      try {
        saveUserData(state.userData, storageOptions);
      } catch (error) {
        console.error('Failed to save user data', error);
        showToast('Unable to save your data in this browser', { variant: 'error' });
      }
    },
  });
}

// --- App hydration ---

const adoptExternalChange = (data: UserDataStore): void => {
  state.userData = data;
  render();
  renderDataNotice();
};

const hydrateApp = async (): Promise<void> => {
  let me: ApiUser;
  try {
    me = await fetchMe();
  } catch (error) {
    if (error instanceof AuthError) {
      setScreen('login');
      return;
    }
    setScreen('app');
    showToast('Unable to verify session', { variant: 'error' });
    return;
  }

  state.me = me.username;
  // Only now, with identity known, is any user data read (#9 per-account isolation).
  activateAccount(me.id, adoptExternalChange);
  renderDataNotice();
  setScreen('app');

  // Snapshots are reconciled inside syncGuildList only when the list loads successfully.
  // fetchGuilds refuses a list for any account other than the one whose data is loaded.
  const epoch = currentAccountEpoch();
  const outcome = await syncGuildList(() => fetchGuilds(me.id), () => state.userData, {
    storageOptions,
    isCurrent: () => isAccountCurrent(epoch),
  });
  applyGuildSyncOutcome(outcome);
  // Syncing may have preserved newer-version data another tab saved meanwhile.
  if (outcome.ok) renderDataNotice();
};

// --- Boot ---

try {
  setFooterYear();
  setFooterBuildInfo();
  setupEvents({ importModal, fetchModal, instructionsModal, demoModal, categoriesModal });
  setupDemoMode();
  discardLegacyUserData();
  renderDataNotice();
  // Includes saves that preserve another tab's newer data before its storage event arrives.
  onNewerPayloadPreserved(renderDataNotice);
  if (isDemoMode) {
    // Adopt saves from other demo tabs; signed-in accounts get theirs from activateAccount.
    watchPersistedUserData(() => state.userData, adoptExternalChange, storageOptions);
    hydrateDemo();
  } else {
    // Another tab signed in as a different account: this tab's requests now act for it.
    watchAccountSwitch(() => handleAccountChanged());
    void hydrateApp();
  }
} catch (error) {
  console.error('Boot failure:', error);
  showErrorScreen();
}
