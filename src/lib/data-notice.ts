import {
  discardUnsupportedBackups,
  getUnpreservedPayload,
  listUnsupportedBackups,
  releaseUnpreservedPayload,
  type UnsupportedBackup,
} from './storage';
import { createElement } from './utils';

interface StorageOptions {
  storageKey?: string;
}

const downloadBackup = (backup: UnsupportedBackup, filename: string): void => {
  const blob = new Blob([backup.payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

/**
 * Persistent notice for user data written by a newer Metacord version. loadUserData keeps
 * such data in backup keys instead of loading it; this makes that visible and lets the user
 * download it (to import in a version that supports it) or discard it after confirmation.
 *
 * When no backup copy fit in storage, the payload is held in memory and saving is paused so
 * the main key keeps it. Downloading or discarding it resumes saving and calls
 * `onWritesResumed` so the caller can persist changes made while saving was paused.
 */
export const renderUnsupportedDataNotice = (
  container: HTMLElement,
  options?: StorageOptions,
  hooks?: { onWritesResumed?: () => void },
): void => {
  const backups = listUnsupportedBackups(options);
  const unpreserved = getUnpreservedPayload(options);
  const entries = unpreserved ? [...backups, unpreserved] : backups;
  container.replaceChildren();
  container.classList.toggle('hidden', entries.length === 0);
  if (entries.length === 0) return;

  const rerender = () => renderUnsupportedDataNotice(container, options, hooks);
  const resumeWrites = (release: { discard: boolean }) => {
    releaseUnpreservedPayload(options, release);
    hooks?.onWritesResumed?.();
  };

  const versions = [...new Set(entries.map((entry) => entry.version).filter((v): v is number => v !== null))];
  const versionLabel = versions.length > 0 ? ` (schema v${versions.join(', v')})` : '';
  container.appendChild(createElement('p', 'data-notice-title', 'Saved data from a newer Metacord version was not loaded'));
  container.appendChild(
    createElement(
      'p',
      'data-notice-body',
      `Your favorites, notes and other user data in this browser were written by a newer version${versionLabel}. ` +
        'They are preserved here, not deleted. Download them to keep a copy and import the file in a version that supports it.',
    ),
  );
  if (unpreserved) {
    container.appendChild(
      createElement(
        'p',
        'data-notice-body data-notice-warning',
        'Saving is paused: browser storage had no room for a separate copy, so saving now would overwrite that data. ' +
          'Until you download or discard it, changes you make are not saved and will be lost when you leave or reload this page.',
      ),
    );
  }

  const actions = createElement('div', 'data-notice-actions');
  entries.forEach((entry, index) => {
    const suffix = entries.length > 1 ? `_${index + 1}` : '';
    const label = entries.length > 1 ? `Download preserved data ${index + 1}` : 'Download preserved data';
    const button = createElement('button', 'btn btn-secondary btn-sm', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      downloadBackup(entry, `user_data_v${entry.version ?? 'unknown'}_preserved${suffix}.json`);
      if (entry === unpreserved) {
        // The download is now the user's copy, so the main key may be overwritten.
        resumeWrites({ discard: false });
        rerender();
      }
    });
    actions.appendChild(button);
  });
  const discard = createElement('button', 'btn btn-ghost btn-sm', 'Discard preserved data');
  discard.type = 'button';
  discard.addEventListener('click', () => {
    const confirmed = confirm(
      'Discard the preserved data from the newer Metacord version? Download it first if you might need it. This cannot be undone.',
    );
    if (!confirmed) return;
    discardUnsupportedBackups(options);
    if (unpreserved) resumeWrites({ discard: true });
    rerender();
  });
  actions.appendChild(discard);
  container.appendChild(actions);
};
