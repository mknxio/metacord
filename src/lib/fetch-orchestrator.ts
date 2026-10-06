import {
  AuthError,
  RateLimitError,
  fetchWidget,
} from './api';
import {
  clearWidgetCache,
  updateLastFetchTimestamp,
  updateWidgetCache,
  type WidgetCacheEntry,
} from './storage';
import { formatRelativeTime, formatSecondsRemaining } from './utils';
import {
  getElement,
  isDemoMode,
  state,
  storageOptions,
} from './state';
import { render, setScreen, showToast } from './render';
import type { ModalController } from '../components/modal';

export const FETCH_BATCH_SIZE = 5;
export const FETCH_BATCH_DELAY_MS = 1000;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchState = {
  shouldStop: false,
  inProgress: false,
  lastRunTimerId: undefined as number | undefined,
  rateLimitTimerId: undefined as number | undefined,
  rateLimitUntil: null as number | null,
};

let _fetchModal: ModalController | null = null;

export const initFetchOrchestrator = (fetchModal: ModalController): void => {
  _fetchModal = fetchModal;
};

export const updateFetchButtonState = (): void => {
  if (isDemoMode) return;

  const fetchButton = getElement<HTMLButtonElement>('btn-fetch');
  const fetchTooltipAnchor = getElement<HTMLElement>('fetch-tooltip-anchor');
  const fetchTooltip = getElement<HTMLElement>('fetch-tooltip');

  // Rate limit backoff takes priority over the in-progress state
  const isRateLimited = fetchState.rateLimitUntil !== null && fetchState.rateLimitUntil > Date.now();
  const isDisabled = isRateLimited || fetchState.inProgress;

  fetchButton.disabled = isDisabled;
  fetchButton.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');

  if (isRateLimited) {
    const secondsRemaining = Math.ceil((fetchState.rateLimitUntil! - Date.now()) / 1000);
    const formatted = formatSecondsRemaining(secondsRemaining);
    fetchTooltip.textContent = `Rate limited by Discord. Available in ${formatted}.`;
    fetchTooltip.classList.add('is-cooldown');
    fetchTooltipAnchor.classList.add('is-tooltip-active');
    fetchTooltipAnchor.setAttribute('tabindex', '0');
    fetchTooltip.setAttribute('aria-hidden', 'false');
  } else if (fetchState.inProgress) {
    fetchTooltip.textContent = 'Fetch in progress...';
    fetchTooltip.classList.remove('is-cooldown');
    fetchTooltipAnchor.classList.add('is-tooltip-active');
    fetchTooltipAnchor.setAttribute('tabindex', '0');
    fetchTooltip.setAttribute('aria-hidden', 'false');
  } else {
    fetchTooltip.textContent = '';
    fetchTooltip.classList.remove('is-cooldown');
    fetchTooltipAnchor.classList.remove('is-tooltip-active');
    fetchTooltipAnchor.removeAttribute('tabindex');
    fetchTooltip.setAttribute('aria-hidden', 'true');
  }
};

export const updateFetchLastRunDisplay = (): void => {
  const fetchLastRun = getElement<HTMLElement>('fetch-last-run');

  if (isDemoMode) {
    fetchLastRun.textContent = '';
    return;
  }

  const timestamp = state.userData.lastFetchTimestamp;
  if (timestamp) {
    fetchLastRun.textContent = `Last fetched ${formatRelativeTime(timestamp)}`;
  } else {
    fetchLastRun.textContent = '';
  }
};

export const stopLastRunTimer = (): void => {
  if (fetchState.lastRunTimerId !== undefined) {
    window.clearInterval(fetchState.lastRunTimerId);
    fetchState.lastRunTimerId = undefined;
  }
};

/** Keep the relative "Last fetched" label current while the app is open. */
export const startLastRunTimer = (): void => {
  stopLastRunTimer();
  updateFetchLastRunDisplay();
  fetchState.lastRunTimerId = window.setInterval(updateFetchLastRunDisplay, 60000); // Update every minute
};

export const stopRateLimitTimer = (): void => {
  if (fetchState.rateLimitTimerId !== undefined) {
    window.clearInterval(fetchState.rateLimitTimerId);
    fetchState.rateLimitTimerId = undefined;
  }
  fetchState.rateLimitUntil = null;
};

export const startRateLimitTimer = (retryAfterSeconds: number): void => {
  stopRateLimitTimer();
  fetchState.rateLimitUntil = Date.now() + retryAfterSeconds * 1000;

  const tick = (): void => {
    updateFetchButtonState();
    if (fetchState.rateLimitUntil === null || fetchState.rateLimitUntil <= Date.now()) {
      stopRateLimitTimer();
    }
  };

  tick();
  fetchState.rateLimitTimerId = window.setInterval(tick, 1000); // Update every second for rate limit
};

export const updateFetchSkipInfo = (): void => {
  const fetchSkipInfo = getElement<HTMLElement>('fetch-skip-info');
  const fetchForce = getElement<HTMLInputElement>('fetch-force');

  if (fetchForce.checked) {
    fetchSkipInfo.textContent = 'All cached results will be cleared before fetching.';
    return;
  }
  const cachedCount = Object.keys(state.userData.widgetCache).length;
  fetchSkipInfo.textContent =
    cachedCount === 0
      ? 'No cached widget data yet.'
      : `${cachedCount} servers already cached and will be skipped.`;
};

export const performWidgetFetch = async (): Promise<void> => {
  if (isDemoMode) {
    showToast('Demo mode uses local data only.');
    return;
  }

  const fetchForce = getElement<HTMLInputElement>('fetch-force');
  const fetchProgressInline = getElement<HTMLElement>('fetch-progress-inline');
  const fetchInlineText = getElement<HTMLElement>('fetch-inline-text');
  const fetchInlineBar = getElement<HTMLElement>('fetch-inline-bar');
  const fetchInlineDetail = getElement<HTMLElement>('fetch-inline-detail');

  // Close modal and show inline progress
  _fetchModal?.close();
  fetchState.shouldStop = false;
  fetchState.inProgress = true;
  updateFetchButtonState();

  // Show inline progress
  fetchProgressInline.classList.remove('hidden');
  fetchInlineBar.classList.remove('is-stopped');
  fetchInlineBar.style.width = '0%';
  fetchInlineText.textContent = 'Fetching...';
  fetchInlineDetail.textContent = '';

  const force = fetchForce.checked;
  if (force) {
    state.userData = clearWidgetCache(state.userData, storageOptions);
  }

  const serverIds = state.guilds.map((guild) => guild.id);
  const targets = force
    ? serverIds
    : serverIds.filter((id) => !state.userData.widgetCache[id]);

  const total = targets.length;
  let completed = 0;
  let widgetsEnabled = 0;
  let widgetsDisabled = 0;
  let errors = 0;
  let rateLimited = false;
  let anySuccess = false;

  if (total === 0) {
    fetchProgressInline.classList.add('hidden');
    fetchState.inProgress = false;
    updateFetchButtonState();
    showToast('All servers already cached', { variant: 'info' });
    return;
  }

  const processBatch = async (batch: string[]): Promise<void> => {
    const results = await Promise.allSettled(
      batch.map(async (guildId) => {
        const widget = await fetchWidget(guildId);
        return { guildId, widget };
      })
    );

    for (const result of results) {
      if (fetchState.shouldStop || rateLimited) break;

      if (result.status === 'fulfilled') {
        anySuccess = true;
        const { guildId, widget } = result.value;
        const hasData = widget.instant_invite != null || widget.presence_count != null;
        const entry: WidgetCacheEntry = {
          instantInvite: widget.instant_invite ?? null,
          presenceCount: widget.presence_count ?? null,
          lastCached: new Date().toISOString(),
        };
        state.userData = updateWidgetCache(state.userData, guildId, entry, storageOptions);
        if (hasData) {
          widgetsEnabled += 1;
        } else {
          widgetsDisabled += 1;
        }
      } else {
        const error = result.reason;
        if (error instanceof AuthError) {
          fetchProgressInline.classList.add('hidden');
          fetchState.inProgress = false;
          updateFetchButtonState();
          setScreen('login');
          return;
        }
        if (error instanceof RateLimitError) {
          rateLimited = true;
          fetchInlineBar.classList.add('is-stopped');
          // Start rate limit timer if we have a retry-after value
          if (error.retryAfter !== null && error.retryAfter > 0) {
            startRateLimitTimer(error.retryAfter);
            const formatted = formatSecondsRemaining(error.retryAfter);
            showToast(`Rate limited by Discord. Available in ${formatted}.`, { variant: 'error' });
          } else {
            showToast('Rate limited by Discord. Try again later.', { variant: 'error' });
          }
          return;
        }
        errors += 1;
      }
      completed += 1;
    }

    const progress = total === 0 ? 100 : Math.round((completed / total) * 100);
    fetchInlineBar.style.width = `${progress}%`;
    fetchInlineText.textContent = `Fetching (${completed}/${total})`;
    fetchInlineDetail.textContent = `${widgetsEnabled} with public data`;
  };

  // Process in batches with delay between each batch
  for (let i = 0; i < targets.length; i += FETCH_BATCH_SIZE) {
    if (fetchState.shouldStop || rateLimited) {
      fetchInlineBar.classList.add('is-stopped');
      break;
    }

    const batch = targets.slice(i, i + FETCH_BATCH_SIZE);
    await processBatch(batch);

    // Add delay between batches (but not after the last one)
    if (i + FETCH_BATCH_SIZE < targets.length && !fetchState.shouldStop && !rateLimited) {
      await delay(FETCH_BATCH_DELAY_MS);
    }
  }

  // Hide inline progress
  fetchProgressInline.classList.add('hidden');
  fetchState.inProgress = false;

  // Update timestamp if any successful responses
  if (anySuccess) {
    state.userData = updateLastFetchTimestamp(state.userData, new Date().toISOString(), storageOptions);
  }

  updateFetchButtonState();
  updateFetchLastRunDisplay();

  // Show completion toast
  const parts: string[] = [];
  if (widgetsEnabled > 0) parts.push(`${widgetsEnabled} public`);
  if (widgetsDisabled > 0) parts.push(`${widgetsDisabled} disabled`);
  if (errors > 0) parts.push(`${errors} errors`);
  const summary = parts.length > 0 ? parts.join(', ') : 'No data found';

  if (rateLimited) {
    // Toast already shown above
  } else if (fetchState.shouldStop) {
    showToast(`Stopped. ${summary}`, { variant: 'info' });
  } else {
    showToast(`Fetch complete. ${summary}`, { variant: 'success' });
  }

  render();
};
