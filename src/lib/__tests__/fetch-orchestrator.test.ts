import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchState,
  startRateLimitTimer,
  stopRateLimitTimer,
  updateFetchButtonState,
} from '../fetch-orchestrator';
import { state } from '../state';

const renderFetchControls = (): void => {
  document.body.innerHTML = `
    <div class="tooltip-anchor" id="fetch-tooltip-anchor">
      <button id="btn-fetch" type="button">Fetch widgets</button>
      <span class="tooltip-pill" id="fetch-tooltip" role="tooltip"></span>
    </div>
    <span id="fetch-last-run"></span>
  `;
};

const fetchButton = (): HTMLButtonElement => document.getElementById('btn-fetch') as HTMLButtonElement;
const fetchTooltip = (): HTMLElement => document.getElementById('fetch-tooltip') as HTMLElement;

describe('updateFetchButtonState', () => {
  beforeEach(() => {
    renderFetchControls();
    state.userData = { ...state.userData, lastFetchTimestamp: null };
    fetchState.inProgress = false;
    stopRateLimitTimer();
  });

  afterEach(() => {
    stopRateLimitTimer();
    fetchState.inProgress = false;
    vi.useRealTimers();
  });

  it('keeps the fetch button enabled right after a completed fetch (no cooldown)', () => {
    state.userData = { ...state.userData, lastFetchTimestamp: new Date().toISOString() };

    updateFetchButtonState();

    expect(fetchButton().disabled).toBe(false);
    expect(fetchButton().getAttribute('aria-disabled')).toBe('false');
    expect(fetchTooltip().textContent).toBe('');
  });

  it('disables the fetch button while a fetch is in progress', () => {
    fetchState.inProgress = true;

    updateFetchButtonState();

    expect(fetchButton().disabled).toBe(true);
    expect(fetchTooltip().textContent).toBe('Fetch in progress...');
  });

  it('disables the fetch button during rate-limit backoff and re-enables it when the backoff ends', () => {
    vi.useFakeTimers();

    startRateLimitTimer(30);

    expect(fetchButton().disabled).toBe(true);
    expect(fetchTooltip().textContent).toBe('Rate limited by Discord. Available in 30s.');

    vi.advanceTimersByTime(31_000);

    expect(fetchState.rateLimitUntil).toBeNull();
    expect(fetchButton().disabled).toBe(false);
  });
});
