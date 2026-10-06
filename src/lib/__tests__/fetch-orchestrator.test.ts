import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FETCH_FALLBACK_BACKOFF_SECONDS,
  fetchState,
  performWidgetFetch,
  startRateLimitTimer,
  stopRateLimitTimer,
  updateFetchButtonState,
} from '../fetch-orchestrator';
import { state } from '../state';
import { showToast } from '../render';
import type { ApiGuild } from '../api';

vi.mock('../render', () => ({
  render: vi.fn(),
  setScreen: vi.fn(),
  showToast: vi.fn(),
}));

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

const renderFetchRunControls = (): void => {
  renderFetchControls();
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <input type="checkbox" id="fetch-force" />
    <div id="fetch-progress-inline" class="hidden">
      <span id="fetch-inline-text"></span>
      <div id="fetch-inline-bar"></div>
      <span id="fetch-inline-detail"></span>
    </div>
  `
  );
};

const guildIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `1000000000000000${String(index).padStart(2, '0')}`);

const asGuilds = (ids: string[]): ApiGuild[] =>
  ids.map((id) => ({ id, name: `Guild ${id}` }) as ApiGuild);

// In-memory storage so saveUserData can persist during a fetch run.
const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
};

const widgetResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('performWidgetFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    renderFetchRunControls();
    vi.stubGlobal('localStorage', createMemoryStorage());
    state.userData = { ...state.userData, widgetCache: {}, lastFetchTimestamp: null };
    fetchState.inProgress = false;
    fetchState.shouldStop = false;
    stopRateLimitTimer();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    stopRateLimitTimer();
    fetchState.inProgress = false;
    state.guilds = [];
    vi.unstubAllGlobals();
  });

  it('stops the run and starts the backoff timer from a 429 body retry_after', async () => {
    // Two batches: the 429 in the first batch must stop the run before the second is sent.
    state.guilds = asGuilds(guildIds(10));
    fetchMock.mockImplementation(async (url: string) =>
      url.includes(guildIds(10)[2])
        ? widgetResponse(429, { message: 'You are being rate limited.', retry_after: 42.3, global: false })
        : widgetResponse(200, { instant_invite: null, presence_count: 3 })
    );

    const before = Date.now();
    await performWidgetFetch();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchState.rateLimitUntil).not.toBeNull();
    expect(fetchState.rateLimitUntil! - before).toBeGreaterThanOrEqual(43_000);
    expect(fetchState.rateLimitUntil! - before).toBeLessThan(44_000);
    expect(fetchButton().disabled).toBe(true);
    expect(fetchTooltip().textContent).toBe('Rate limited by Discord. Available in 43s.');
    expect(showToast).toHaveBeenCalledWith('Rate limited by Discord. Available in 43s.', { variant: 'error' });
  });

  it('applies the fallback backoff when a 429 has no readable retry hint', async () => {
    state.guilds = asGuilds(guildIds(1));
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));

    await performWidgetFetch();

    expect(fetchState.rateLimitUntil).not.toBeNull();
    expect(fetchButton().disabled).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      `Rate limited by Discord. Available in ${FETCH_FALLBACK_BACKOFF_SECONDS / 60}m.`,
      { variant: 'error' }
    );
  });

  it('backs off instead of continuing when a whole batch fails at the network layer', async () => {
    // An opaque cross-origin response (for example an edge-level 429 without CORS headers)
    // reaches the client only as a TypeError.
    state.guilds = asGuilds(guildIds(10));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await performWidgetFetch();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchState.rateLimitUntil).not.toBeNull();
    expect(fetchButton().disabled).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      'Could not reach Discord. Requests may be rate limited or blocked. Try again in 1m.',
      { variant: 'error' }
    );
    expect(state.userData.lastFetchTimestamp).toBeNull();
  });

  it('counts isolated network failures as errors and finishes the batch', async () => {
    state.guilds = asGuilds(guildIds(3));
    fetchMock
      .mockResolvedValueOnce(widgetResponse(200, { instant_invite: 'https://discord.com/invite/abc', presence_count: 7 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(widgetResponse(403, { message: 'Widget Disabled', code: 50004 }));

    await performWidgetFetch();

    expect(fetchState.rateLimitUntil).toBeNull();
    expect(fetchButton().disabled).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Fetch complete. 1 public, 1 disabled, 1 errors', { variant: 'success' });
  });
});
