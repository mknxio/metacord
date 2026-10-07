import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

// state.ts reads localStorage at import time; give it a working one first.
vi.hoisted(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
});

import { activateAccount } from '../account';
import { ACCOUNT_CHANGED_MESSAGE, handleAccountChanged, invalidateAccountView } from '../account-view';
import { renderUnsupportedDataNotice } from '../data-notice';
import { initSetScreen, setScreen } from '../render';
import { state, storageOptions } from '../state';
import { accountStorageKey, unsupportedBackupKey } from '../storage';

const A = '111';
const closeOverlays = vi.fn();
const byId = (id: string) => document.getElementById(id) as HTMLElement;

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  initSetScreen(closeOverlays);
});

/** Account A signed in, with its details modal open and a preserved-data notice showing. */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  closeOverlays.mockClear();
  activateAccount(A, () => {});
  localStorage.setItem(unsupportedBackupKey({ storageKey: accountStorageKey(A) }), '{"version":9,"notes":{"1":"A secret"}}');
  setScreen('app');
  byId('details-body').textContent = 'A private note';
  byId('categories-list').textContent = 'A category';
  renderUnsupportedDataNotice(byId('data-notice'), storageOptions);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invalidating the account view', () => {
  it('closes and empties overlays, clears the notice and makes its buttons inert', () => {
    const download = [...byId('data-notice').querySelectorAll('button')].find(
      (button) => button.textContent === 'Download preserved data',
    ) as HTMLButtonElement;
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(download).toBeDefined();

    handleAccountChanged(vi.fn());

    expect(closeOverlays).toHaveBeenCalled();
    expect(byId('app-shell').classList.contains('hidden')).toBe(true);
    expect(byId('login-screen').classList.contains('hidden')).toBe(false);
    expect(byId('login-status').textContent).toBe(ACCOUNT_CHANGED_MESSAGE);
    expect(byId('details-body').textContent).toBe('');
    expect(byId('categories-list').textContent).toBe('');
    expect(byId('data-notice').childElementCount).toBe(0);
    expect(byId('data-notice').classList.contains('hidden')).toBe(true);
    expect(state.accountId).toBeNull();

    // A handler captured before the switch must not export A's payload afterwards.
    download.click();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('still invalidates fully when the reload is blocked by the per-tab guard', () => {
    const reload = vi.fn();
    handleAccountChanged(reload);
    activateAccount(A, () => {});
    setScreen('app');
    byId('details-body').textContent = 'A private note';
    handleAccountChanged(reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(byId('details-body').textContent).toBe('');
    expect(byId('app-shell').classList.contains('hidden')).toBe(true);
    expect(byId('login-status').textContent).toBe(ACCOUNT_CHANGED_MESSAGE);
  });

  it('signs out without an account-changed message on logout', () => {
    invalidateAccountView();
    expect(byId('login-status').textContent).toBe('');
    expect(byId('details-body').textContent).toBe('');
    expect(state.accountId).toBeNull();
  });
});
