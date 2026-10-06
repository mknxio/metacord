import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderUnsupportedDataNotice } from '../data-notice';
import { listUnsupportedBackups, loadUserData } from '../storage';

const TEST_KEY = '__test_data_notice_key__';
const opts = { storageKey: TEST_KEY };

function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('localStorage', createLocalStorageMock());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  container.className = 'hidden';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const preserveNewerData = (): string => {
  const newer = JSON.stringify({ version: 7, favorites: ['future'] });
  localStorage.setItem(TEST_KEY, newer);
  loadUserData(opts);
  return newer;
};

describe('renderUnsupportedDataNotice', () => {
  it('stays hidden when nothing was preserved', () => {
    renderUnsupportedDataNotice(container, opts);
    expect(container.classList.contains('hidden')).toBe(true);
    expect(container.childElementCount).toBe(0);
  });

  it('tells the user newer data was preserved and offers a download', () => {
    const newer = preserveNewerData();
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:preserved';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });

    renderUnsupportedDataNotice(container, opts);
    expect(container.classList.contains('hidden')).toBe(false);
    expect(container.textContent).toContain('newer Metacord version');
    expect(container.textContent).toContain('schema v7');

    const download = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Download preserved data');
    download?.click();
    expect(clicks).toEqual(['user_data_v7_preserved.json']);
    return blobs[0].text().then((text) => expect(text).toBe(newer));
  });

  it('discards preserved data only after confirmation', () => {
    preserveNewerData();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderUnsupportedDataNotice(container, opts);
    const discard = () =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Discard preserved data');

    discard()?.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(listUnsupportedBackups(opts)).toHaveLength(1);

    confirmSpy.mockReturnValue(true);
    discard()?.click();
    expect(listUnsupportedBackups(opts)).toHaveLength(0);
    expect(container.classList.contains('hidden')).toBe(true);
  });
});
