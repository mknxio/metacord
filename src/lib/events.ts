import { logout } from './api';
import {
  exportUserData,
  toggleFavorite,
  saveUserData,
  addCategory,
  updateCategory,
  deleteCategory,
  moveCategory,
} from './storage';
import { createElement } from './utils';
import { importReconciledUserData } from './guild-sync';
import type { ModalController } from '../components/modal';
import {
  BUILTIN_SECTIONS,
  type FilterKey,
  type SectionKey,
  type SortKey,
  collapsedSections,
  filterTooltipCopy,
  getElement,
  getSections,
  isDemoMode,
  saveCollapsedSections,
  saveSortPreference,
  state,
  storageOptions,
} from './state';
import { render, setImportStatus, setScreen, showToast, getVisibleServerIds } from './render';
import {
  fetchState,
  performWidgetFetch,
  startCooldownTimer,
  updateFetchButtonState,
  updateFetchLastRunDisplay,
  updateFetchSkipInfo,
} from './fetch-orchestrator';
import {
  handleDemoFile,
  setDemoModalStatus,
  setDemoStatus,
  setDemoUserDataLoaded,
} from './demo';

const updateFilterClearVisibility = (): void => {
  const clearButton = document.getElementById('filter-clear');
  if (clearButton) {
    const hasActiveFilters = state.activeFilters.size > 0;
    clearButton.classList.toggle('hidden', !hasActiveFilters);
  }
};

const updateFilterUI = (): void => {
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
    const filter = button.dataset.filter as FilterKey | undefined;
    if (!filter || filter === 'all') {
      return;
    }
    const isActive = state.activeFilters.has(filter);
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  updateFilterClearVisibility();
};

const toggleFilter = (filter: FilterKey): void => {
  if (filter === 'all') {
    state.activeFilters.clear();
  } else if (state.activeFilters.has(filter)) {
    state.activeFilters.delete(filter);
  } else {
    state.activeFilters.add(filter);
  }
  updateFilterUI();
  render();
};

const clearFilters = (): void => {
  state.activeFilters.clear();
  updateFilterUI();
  render();
};

const updateSearch = (value: string): void => {
  state.search = value;
  render();
};

const VALID_SORT_KEYS: SortKey[] = ['name-asc', 'name-desc', 'online-desc'];

const updateSort = (value: string): void => {
  if (VALID_SORT_KEYS.includes(value as SortKey)) {
    state.sort = value as SortKey;
    saveSortPreference(state.sort);
    render();
  }
};

const setSectionCollapsed = (sectionKey: SectionKey, collapsed: boolean): void => {
  const sections = getSections();
  const section = sections[sectionKey];
  if (!section) return;

  section.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  section.content.classList.toggle('is-collapsed', collapsed);

  if (collapsed) {
    collapsedSections.add(sectionKey);
  } else {
    collapsedSections.delete(sectionKey);
  }
  saveCollapsedSections(collapsedSections);
};

const toggleSectionCollapse = (sectionKey: SectionKey): void => {
  const sections = getSections();
  const section = sections[sectionKey];
  if (!section) return;

  const isExpanded = section.header.getAttribute('aria-expanded') === 'true';
  setSectionCollapsed(sectionKey, isExpanded);
};

const initializeSectionStates = (): void => {
  const sections = getSections();
  BUILTIN_SECTIONS.forEach((key) => {
    const section = sections[key];
    if (!section) return;

    const isCollapsed = collapsedSections.has(key);
    section.header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    section.content.classList.toggle('is-collapsed', isCollapsed);
  });
};

const handleImport = async (file: File): Promise<boolean> => {
  const loginScreen = getElement<HTMLElement>('login-screen');
  try {
    const content = await file.text();
    const parsed: unknown = JSON.parse(content);
    // Saves once, after reconciliation; on any failure state and storage keep the old data.
    state.userData = importReconciledUserData(
      parsed,
      state.guildListLoaded ? state.guilds : null,
      new Date().toISOString(),
      storageOptions,
    );
    if (isDemoMode && loginScreen.getAttribute('aria-hidden') === 'false') {
      setDemoUserDataLoaded(true);
      const message = 'User data loaded. Load guilds_api.json to continue.';
      setImportStatus(message, 'neutral');
      setDemoStatus(message, 'neutral');
    }
    showToast('User data imported');
    render();
    return true;
  } catch (error) {
    console.error(error);
    showToast('Import failed', { variant: 'error' });
    setImportStatus('Import failed. Expect user_data.json.', 'error');
    return false;
  }
};

const handleExport = (): void => {
  const blob = new Blob([exportUserData(state.userData)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'user_data.json';
  link.click();
  URL.revokeObjectURL(url);
  showToast('User data exported');
};

const updateImportModalCopy = (): void => {
  const importCopy = getElement<HTMLElement>('import-copy');
  const importGuildsCard = getElement<HTMLElement>('import-guilds-card');
  const importUserCopy = getElement<HTMLElement>('import-user-copy');
  const importUserMeta = getElement<HTMLElement>('import-user-meta');
  const importGuildsMeta = getElement<HTMLElement>('import-guilds-meta');
  const importUserLabel = getElement<HTMLElement>('import-user-label');

  setImportStatus('', 'neutral');
  importGuildsCard.classList.toggle('hidden', !isDemoMode);
  if (isDemoMode) {
    importCopy.textContent =
      'Import your Discord data. Start with your server list, then optionally restore your backup.';
    importUserCopy.textContent =
      'Restore favorites, notes, nicknames, and widgets from a backup.';
    importUserMeta.textContent = 'Optional in demo mode.';
    importGuildsMeta.textContent = 'Optional if you have it.';
    importUserLabel.textContent = 'Optional';
    importUserLabel.classList.remove('hidden');
  } else {
    importCopy.textContent = 'Restore your favorites, notes, nicknames, and widgets from a backup.';
    importUserCopy.textContent =
      'Export your user data from the app to create a backup, then restore it here.';
    importUserMeta.textContent = '';
    importUserLabel.textContent = '';
    importUserLabel.classList.add('hidden');
  }
};

const openImportModal = (importModal: ModalController, trigger?: HTMLElement | null): void => {
  updateImportModalCopy();
  importModal.open(trigger);
};

const createCopyHandler = (
  button: HTMLButtonElement,
  getText: () => string,
): (() => Promise<void>) => {
  let timeoutId: number | undefined;
  const originalLabel = button.getAttribute('aria-label') ?? 'Copy code to clipboard';

  return async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(getText());

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }

      button.classList.add('is-copied');
      button.setAttribute('aria-label', 'Copied!');
      const icon = button.querySelector('i');
      if (icon) {
        icon.classList.remove('fa-copy');
        icon.classList.add('fa-check');
      }

      timeoutId = window.setTimeout(() => {
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', originalLabel);
        if (icon) {
          icon.classList.remove('fa-check');
          icon.classList.add('fa-copy');
        }
        timeoutId = undefined;
      }, 2000);
    } catch {
      showToast('Unable to copy code', { variant: 'error' });
    }
  };
};

const attachFilterTooltips = (): void => {
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
    if (button.closest('.tooltip-anchor')) {
      return;
    }
    const filter = button.dataset.filter as FilterKey | undefined;
    if (!filter) {
      return;
    }
    const tooltipText = filterTooltipCopy[filter];
    if (!tooltipText) {
      return;
    }
    const anchor = createElement('span', 'tooltip-anchor is-tooltip-active');
    const tooltip = createElement('span', 'tooltip-pill', tooltipText);
    const tooltipId = `filter-tooltip-${filter}`;
    tooltip.id = tooltipId;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'false');
    const parent = button.parentElement;
    if (!parent) {
      return;
    }
    parent.insertBefore(anchor, button);
    anchor.append(button, tooltip);
    button.setAttribute('aria-describedby', tooltipId);
  });
};

const enterSelectionMode = (): void => {
  state.selectionMode = true;
  state.selectedIds.clear();
  render();
};

const exitSelectionMode = (): void => {
  state.selectionMode = false;
  state.selectedIds.clear();
  render();
};

const toggleSelectionMode = (): void => {
  if (state.selectionMode) {
    exitSelectionMode();
  } else {
    enterSelectionMode();
  }
};

const bulkSelectAll = (): void => {
  const ids = getVisibleServerIds();
  ids.forEach((id) => state.selectedIds.add(id));
  render();
};

const bulkDeselectAll = (): void => {
  state.selectedIds.clear();
  render();
};

const bulkFavorite = (): void => {
  const toAdd = [...state.selectedIds].filter(
    (guildId) => !state.userData.favorites.includes(guildId),
  );
  if (toAdd.length > 0) {
    state.userData = {
      ...state.userData,
      favorites: [...state.userData.favorites, ...toAdd],
    };
    saveUserData(state.userData, storageOptions);
  }
  const count = toAdd.length;
  exitSelectionMode();
  showToast(`Added ${count} server${count === 1 ? '' : 's'} to favorites`);
};

const bulkUnfavorite = (): void => {
  const toRemove = new Set(
    [...state.selectedIds].filter((guildId) =>
      state.userData.favorites.includes(guildId),
    ),
  );
  if (toRemove.size > 0) {
    state.userData = {
      ...state.userData,
      favorites: state.userData.favorites.filter((id) => !toRemove.has(id)),
    };
    saveUserData(state.userData, storageOptions);
  }
  const count = toRemove.size;
  exitSelectionMode();
  showToast(`Removed ${count} server${count === 1 ? '' : 's'} from favorites`);
};

export interface SetupEventsOptions {
  importModal: ModalController;
  fetchModal: ModalController;
  instructionsModal: ModalController;
  demoModal: ModalController;
  categoriesModal: ModalController;
}

export const setupEvents = (options: SetupEventsOptions): void => {
  const { importModal, fetchModal, instructionsModal, demoModal, categoriesModal } = options;

  const searchInput = getElement<HTMLInputElement>('search-input');
  const fetchButton = getElement<HTMLButtonElement>('btn-fetch');
  const fetchTooltipAnchor = getElement<HTMLElement>('fetch-tooltip-anchor');
  const fetchTooltip = getElement<HTMLElement>('fetch-tooltip');
  const fetchStart = getElement<HTMLButtonElement>('fetch-start');
  const fetchForce = getElement<HTMLInputElement>('fetch-force');
  const fetchInlineStop = getElement<HTMLButtonElement>('fetch-inline-stop');
  const importButton = getElement<HTMLButtonElement>('btn-import');
  const importUserInput = getElement<HTMLInputElement>('import-user-input');
  const importGuildsInput = getElement<HTMLInputElement>('import-guilds-input');
  const importInstructionsLink = getElement<HTMLButtonElement>('import-instructions-link');
  const instructionsCodeCopy = getElement<HTMLButtonElement>('instructions-code-copy');
  const instructionsCodeSnippet = getElement<HTMLPreElement>('instructions-code-snippet');
  const demoInstructionsLink = getElement<HTMLButtonElement>('demo-instructions-link');
  const demoImportButton = getElement<HTMLButtonElement>('demo-import-button');
  const demoGuildsInput = getElement<HTMLInputElement>('demo-guilds-input');
  const loginScreen = getElement<HTMLElement>('login-screen');

  attachFilterTooltips();
  initializeSectionStates();

  document.querySelectorAll<HTMLButtonElement>('[data-collapse-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const sectionKey = button.dataset.collapseToggle as SectionKey | undefined;
      if (sectionKey) {
        toggleSectionCollapse(sectionKey);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const filter = button.dataset.filter as FilterKey | undefined;
      if (filter) {
        toggleFilter(filter);
      }
    });
  });

  const filterClearButton = document.getElementById('filter-clear');
  if (filterClearButton) {
    filterClearButton.addEventListener('click', clearFilters);
  }

  searchInput.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    updateSearch(target.value);
  });

  const sortSelectEl = document.getElementById('sort-select');
  if (sortSelectEl) {
    (sortSelectEl as unknown as HTMLSelectElement).value = state.sort;
    sortSelectEl.addEventListener('change', (event) => {
      const target = event.target as unknown as HTMLSelectElement;
      updateSort(target.value);
    });
  }

  getElement<HTMLButtonElement>('btn-export').addEventListener('click', handleExport);

  if (!isDemoMode) {
    fetchButton.addEventListener('click', () => {
      updateFetchSkipInfo();
      fetchModal.open();
    });
    // Initialize cooldown state
    updateFetchButtonState();
    updateFetchLastRunDisplay();
    startCooldownTimer();
  } else {
    fetchButton.disabled = true;
    fetchButton.setAttribute('aria-disabled', 'true');
    fetchTooltipAnchor.classList.add('is-tooltip-active');
    fetchTooltipAnchor.setAttribute('tabindex', '0');
    fetchTooltipAnchor.setAttribute('aria-describedby', 'fetch-tooltip');
    fetchTooltip.setAttribute('aria-hidden', 'false');
  }

  getElement<HTMLButtonElement>('btn-logout').addEventListener('click', async () => {
    if (isDemoMode) {
      setScreen('login');
      setDemoStatus('Load guilds_api.json to continue.', 'neutral');
      return;
    }
    try {
      await logout();
    } catch (error) {
      console.error(error);
    } finally {
      setScreen('login');
    }
  });

  importButton.addEventListener('click', (event) => {
    openImportModal(importModal, event.currentTarget as HTMLElement);
  });

  importInstructionsLink.addEventListener('click', (event) => {
    instructionsModal.open(event.currentTarget as HTMLElement);
  });

  const handleInstructionsCodeCopy = createCopyHandler(
    instructionsCodeCopy,
    () => instructionsCodeSnippet.textContent ?? '',
  );
  instructionsCodeCopy.addEventListener('click', handleInstructionsCodeCopy);

  demoInstructionsLink.addEventListener('click', (event) => {
    instructionsModal.open(event.currentTarget as HTMLElement);
  });

  demoImportButton.addEventListener('click', (event) => {
    setDemoModalStatus('', 'neutral');
    demoModal.open(event.currentTarget as HTMLElement);
  });

  importUserInput.addEventListener('change', () => {
    const file = importUserInput.files?.[0];
    if (!file) {
      return;
    }
    const handleImportFlow = async (): Promise<void> => {
      const success = await handleImport(file);
      if (success) {
        if (!(isDemoMode && loginScreen.getAttribute('aria-hidden') === 'false')) {
          importModal.close();
        }
      }
    };
    void handleImportFlow();
    importUserInput.value = '';
  });

  importGuildsInput.addEventListener('change', () => {
    const file = importGuildsInput.files?.[0];
    if (!file) {
      return;
    }
    const handleImportFlow = async (): Promise<void> => {
      const success = await handleDemoFile(file);
      if (success) {
        setDemoUserDataLoaded(false);
        importModal.close();
      }
    };
    void handleImportFlow();
    importGuildsInput.value = '';
  });

  demoGuildsInput.addEventListener('change', () => {
    const file = demoGuildsInput.files?.[0];
    if (!file) {
      return;
    }
    const handleImportFlow = async (): Promise<void> => {
      const success = await handleDemoFile(file);
      if (success) {
        setDemoUserDataLoaded(false);
        demoModal.close();
      }
    };
    void handleImportFlow();
    demoGuildsInput.value = '';
  });

  fetchStart.addEventListener('click', () => {
    void performWidgetFetch();
  });
  fetchInlineStop.addEventListener('click', () => {
    fetchState.shouldStop = true;
  });
  fetchForce.addEventListener('change', updateFetchSkipInfo);

  // --- Categories management ---
  const categoriesButton = getElement<HTMLButtonElement>('btn-categories');
  const categoryNameInput = getElement<HTMLInputElement>('category-name-input');
  const addCategoryButton = getElement<HTMLButtonElement>('btn-add-category');

  const renderCategoriesList = (): void => {
    const list = getElement<HTMLElement>('categories-list');
    list.replaceChildren();
    const sorted = [...state.userData.categories].sort((a, b) => a.order - b.order);
    if (sorted.length === 0) {
      const empty = createElement('p', 'muted', 'No categories yet. Add one above.');
      list.appendChild(empty);
      return;
    }
    sorted.forEach((cat, index) => {
      const item = createElement('div', 'category-item');
      item.setAttribute('role', 'listitem');
      const nameSpan = createElement('span', 'category-item-name', cat.name);
      const actionsRow = createElement('div', 'category-item-actions');

      const upBtn = createElement('button', 'btn btn-ghost btn-sm', '\u2191');
      upBtn.type = 'button';
      upBtn.setAttribute('aria-label', `Move ${cat.name} up`);
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        state.userData = moveCategory(state.userData, cat.id, 'up', storageOptions);
        renderCategoriesList();
        render();
      });

      const downBtn = createElement('button', 'btn btn-ghost btn-sm', '\u2193');
      downBtn.type = 'button';
      downBtn.setAttribute('aria-label', `Move ${cat.name} down`);
      downBtn.disabled = index === sorted.length - 1;
      downBtn.addEventListener('click', () => {
        state.userData = moveCategory(state.userData, cat.id, 'down', storageOptions);
        renderCategoriesList();
        render();
      });

      const renameBtn = createElement('button', 'btn btn-secondary btn-sm', 'Rename');
      renameBtn.type = 'button';
      renameBtn.setAttribute('aria-label', `Rename ${cat.name}`);
      renameBtn.addEventListener('click', () => {
        const newName = prompt('Rename category:', cat.name);
        if (newName !== null && newName.trim().length > 0) {
          state.userData = updateCategory(state.userData, cat.id, newName, storageOptions);
          renderCategoriesList();
          render();
          showToast('Category renamed');
        }
      });

      const deleteBtn = createElement('button', 'btn btn-danger btn-sm', 'Delete');
      deleteBtn.type = 'button';
      deleteBtn.setAttribute('aria-label', `Delete ${cat.name}`);
      deleteBtn.addEventListener('click', () => {
        if (confirm(`Delete category "${cat.name}"? Servers in it will be uncategorized.`)) {
          state.userData = deleteCategory(state.userData, cat.id, storageOptions);
          renderCategoriesList();
          render();
          showToast('Category deleted');
        }
      });

      actionsRow.append(upBtn, downBtn, renameBtn, deleteBtn);
      item.append(nameSpan, actionsRow);
      list.appendChild(item);
    });
  };

  categoriesButton.addEventListener('click', (event) => {
    renderCategoriesList();
    categoriesModal.open(event.currentTarget as HTMLElement);
  });

  addCategoryButton.addEventListener('click', () => {
    const name = categoryNameInput.value.trim();
    if (name.length === 0) return;
    state.userData = addCategory(state.userData, name, storageOptions);
    categoryNameInput.value = '';
    renderCategoriesList();
    render();
    showToast(`Category "${name}" created`);
  });

  categoryNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addCategoryButton.click();
    }
  });

  // --- Selection mode ---
  const selectToggle = document.getElementById('btn-select-toggle');
  if (selectToggle) {
    selectToggle.addEventListener('click', toggleSelectionMode);
  }

  const bulkSelectAllBtn = document.getElementById('bulk-select-all');
  const bulkDeselectBtn = document.getElementById('bulk-deselect');
  const bulkFavoriteBtn = document.getElementById('bulk-favorite');
  const bulkUnfavoriteBtn = document.getElementById('bulk-unfavorite');
  const bulkCancelBtn = document.getElementById('bulk-cancel');

  bulkSelectAllBtn?.addEventListener('click', bulkSelectAll);
  bulkDeselectBtn?.addEventListener('click', bulkDeselectAll);
  bulkFavoriteBtn?.addEventListener('click', bulkFavorite);
  bulkUnfavoriteBtn?.addEventListener('click', bulkUnfavorite);
  bulkCancelBtn?.addEventListener('click', exitSelectionMode);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.selectionMode) {
      const openOverlay = document.querySelector('.modal-overlay:not(.hidden)');
      if (!openOverlay) {
        exitSelectionMode();
      }
    }
  });
};
