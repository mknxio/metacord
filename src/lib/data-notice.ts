import { discardUnsupportedBackups, listUnsupportedBackups, type UnsupportedBackup } from './storage';
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
 */
export const renderUnsupportedDataNotice = (container: HTMLElement, options?: StorageOptions): void => {
  const backups = listUnsupportedBackups(options);
  container.replaceChildren();
  container.classList.toggle('hidden', backups.length === 0);
  if (backups.length === 0) return;

  const versions = [...new Set(backups.map((backup) => backup.version).filter((v): v is number => v !== null))];
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

  const actions = createElement('div', 'data-notice-actions');
  backups.forEach((backup, index) => {
    const suffix = backups.length > 1 ? `_${index + 1}` : '';
    const label = backups.length > 1 ? `Download preserved data ${index + 1}` : 'Download preserved data';
    const button = createElement('button', 'btn btn-secondary btn-sm', label);
    button.type = 'button';
    button.addEventListener('click', () =>
      downloadBackup(backup, `user_data_v${backup.version ?? 'unknown'}_preserved${suffix}.json`),
    );
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
    renderUnsupportedDataNotice(container, options);
  });
  actions.appendChild(discard);
  container.appendChild(actions);
};
