import {
  discardUnsupportedBackups,
  isUserDataWriteBlocked,
  listUnpreservedPayloads,
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
 * When no backup copy fit in storage, payloads are held in memory and listed here too; while
 * the main key holds one of them, saving is paused. Downloading or discarding releases that
 * exact payload, and `onWritesResumed` runs only if that leaves nothing at risk in the main
 * key, so the caller can persist changes made while saving was paused.
 */
export const renderUnsupportedDataNotice = (
  container: HTMLElement,
  options?: StorageOptions,
  hooks?: { onWritesResumed?: () => void },
): void => {
  const backups = listUnsupportedBackups(options);
  const held = listUnpreservedPayloads(options);
  const entries = [...backups, ...held];
  container.replaceChildren();
  container.classList.toggle('hidden', entries.length === 0);
  if (entries.length === 0) return;

  const rerender = () => renderUnsupportedDataNotice(container, options, hooks);
  const blocked = isUserDataWriteBlocked(options);
  const release = (payloads: string[], discard: boolean) => {
    const wasBlocked = isUserDataWriteBlocked(options);
    payloads.forEach((payload) => releaseUnpreservedPayload(payload, options, { discard }));
    if (wasBlocked && !isUserDataWriteBlocked(options)) hooks?.onWritesResumed?.();
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
  if (blocked) {
    container.appendChild(
      createElement(
        'p',
        'data-notice-body data-notice-warning',
        'Saving is paused: browser storage had no room for a separate copy, so saving now would overwrite that data. ' +
          'Until you download or discard it, changes you make are not saved and will be lost when you leave or reload this page.',
      ),
    );
  } else if (held.length > 0) {
    container.appendChild(
      createElement(
        'p',
        'data-notice-body data-notice-warning',
        'Browser storage had no room for a separate copy, so some of this data exists only in this page. ' +
          'Download it before you leave or reload this page.',
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
      if (held.includes(entry)) {
        // The download is now the user's copy of this payload (and only this one).
        release([entry.payload], false);
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
    release(
      held.map((entry) => entry.payload),
      true,
    );
    rerender();
  });
  actions.appendChild(discard);
  container.appendChild(actions);
};
