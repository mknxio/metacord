import { AuthError, fetchGuilds, fetchMe } from './lib/api';
import { createModalController } from './components/modal';
import { createToastManager } from './components/toast';
import { getElement, isDemoMode, state, storageOptions } from './lib/state';
import { syncGuildList } from './lib/guild-sync';
import {
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
import { saveUserData } from './lib/storage';
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

// --- App hydration ---

const hydrateApp = async (): Promise<void> => {
  try {
    const me = await fetchMe();
    state.me = me.username;
  } catch (error) {
    if (error instanceof AuthError) {
      setScreen('login');
      return;
    }
    setScreen('app');
    showToast('Unable to verify session', { variant: 'error' });
    return;
  }

  setScreen('app');

  // Snapshots are reconciled inside syncGuildList only when the list loads successfully.
  const outcome = await syncGuildList(fetchGuilds, () => state.userData, { storageOptions });
  if (!outcome.ok) {
    if (outcome.error instanceof AuthError) {
      setScreen('login');
      return;
    }
    showToast('Unable to load servers', { variant: 'error' });
    return;
  }
  state.guilds = outcome.guilds;
  state.guildListLoaded = true;
  state.userData = outcome.userData;
  render();
  if (!outcome.persisted) {
    showToast('Server history could not be saved in this browser', { variant: 'error' });
  }
};

// --- Boot ---

try {
  setFooterYear();
  setFooterBuildInfo();
  setupEvents({ importModal, fetchModal, instructionsModal, demoModal, categoriesModal });
  setupDemoMode();
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
  if (isDemoMode) {
    hydrateDemo();
  } else {
    void hydrateApp();
  }
} catch (error) {
  console.error('Boot failure:', error);
  showErrorScreen();
}
