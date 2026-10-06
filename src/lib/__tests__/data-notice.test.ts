import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderUnsupportedDataNotice } from '../data-notice';
import { createDefaultUserData, isUserDataWriteBlocked, listUnsupportedBackups, loadUserData, saveUserData } from '../storage';

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

// The write block is module state keyed by storage key, so each test uses its own key.
describe('renderUnsupportedDataNotice when no backup copy fit', () => {
  const newer = JSON.stringify({ version: 8, notes: { g1: 'irreplaceable' } });

  const loadWithoutRoomForBackup = (storageKey: string) => {
    const options = { storageKey };
    localStorage.setItem(storageKey, newer);
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes('_unsupported_backup')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(key, value);
    });
    loadUserData(options);
    return options;
  };

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label);

  it('says saving is paused and resumes it after the in-memory copy is downloaded', async () => {
    const options = loadWithoutRoomForBackup('__test_notice_unpreserved_download__');
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:unpreserved';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onWritesResumed = vi.fn();

    renderUnsupportedDataNotice(container, options, { onWritesResumed });
    expect(container.classList.contains('hidden')).toBe(false);
    expect(container.textContent).toContain('schema v8');
    expect(container.textContent).toContain('Saving is paused');
    expect(container.textContent).toContain('not saved');

    // While paused, edits never reach the main key.
    saveUserData({ ...createDefaultUserData(), favorites: ['edit'] }, options);
    expect(localStorage.getItem(options.storageKey)).toBe(newer);

    button('Download preserved data')?.click();
    expect(await blobs[0].text()).toBe(newer);
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(onWritesResumed).toHaveBeenCalledTimes(1);
    expect(container.classList.contains('hidden')).toBe(true);
  });

  it('resumes saving after a confirmed discard only', () => {
    const options = loadWithoutRoomForBackup('__test_notice_unpreserved_discard__');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onWritesResumed = vi.fn();
    renderUnsupportedDataNotice(container, options, { onWritesResumed });

    button('Discard preserved data')?.click();
    expect(isUserDataWriteBlocked(options)).toBe(true);
    expect(localStorage.getItem(options.storageKey)).toBe(newer);
    expect(onWritesResumed).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    button('Discard preserved data')?.click();
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(localStorage.getItem(options.storageKey)).toBeNull();
    expect(onWritesResumed).toHaveBeenCalledTimes(1);
    expect(container.classList.contains('hidden')).toBe(true);
  });
});
