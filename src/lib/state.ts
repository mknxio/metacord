import { loadUserData, type UserDataStore } from './storage';

export type FilterKey = 'all' | 'owned' | 'partner' | 'verified' | 'boosted' | 'discoverable';
export type BuiltinSectionKey = 'favorites' | 'owned' | 'public' | 'private' | 'departed';
export type DynamicSectionKey = `category-${string}`;
export type SectionKey = BuiltinSectionKey | DynamicSectionKey;
export type SortKey = 'name-asc' | 'name-desc' | 'online-desc';

export const COLLAPSED_SECTIONS_KEY = 'discord_manager_collapsed_sections';
export const SORT_PREFERENCE_KEY = 'discord_manager_sort_preference';
export const DEMO_GUILDS_KEY = 'discord_manager_demo_guilds';
export const DEMO_STORAGE_KEY = 'discord_manager_demo_user_data';
export const FETCH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export const filterTooltipCopy: Partial<Record<FilterKey, string>> = {
  owned: 'Servers you administer',
  partner: 'Discord Partner Program',
  verified: 'Officially verified server',
  boosted: 'Nitro boost enabled',
  discoverable: 'Listed in Server Discovery',
};

export interface AppState {
  me: string | null;
  guilds: import('./api').ApiGuild[];
  /** True once `guilds` holds a successfully loaded list (live or demo) this session. */
  guildListLoaded: boolean;
  userData: UserDataStore;
  activeFilters: Set<FilterKey>;
  search: string;
  sort: SortKey;
  selectionMode: boolean;
  selectedIds: Set<string>;
}

export interface SectionElements {
  section: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  content: HTMLElement;
  header: HTMLButtonElement;
}

export interface DemoGuildEntry {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  owner: boolean;
  features: string[];
  approximate_member_count: number | null;
  approximate_presence_count: number | null;
}

export const getElement = <T extends HTMLElement>(selector: string): T => {
  const element = selector.startsWith('[') || selector.startsWith('.')
    ? document.querySelector<T>(selector)
    : document.getElementById(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const BUILTIN_SECTIONS: BuiltinSectionKey[] = ['favorites', 'owned', 'public', 'private', 'departed'];

export const isValidSectionKey = (value: string): value is SectionKey =>
  (BUILTIN_SECTIONS as readonly string[]).includes(value) || value.startsWith('category-');

export const loadCollapsedSections = (): Set<SectionKey> => {
  try {
    const stored = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is SectionKey =>
      typeof item === 'string' && isValidSectionKey(item)
    ));
  } catch {
    return new Set();
  }
};

export const saveCollapsedSections = (collapsed: Set<SectionKey>): void => {
  localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsed]));
};

const VALID_SORT_KEYS: SortKey[] = ['name-asc', 'name-desc', 'online-desc'];

export const loadSortPreference = (): SortKey => {
  try {
    const stored = localStorage.getItem(SORT_PREFERENCE_KEY);
    if (stored && VALID_SORT_KEYS.includes(stored as SortKey)) {
      return stored as SortKey;
    }
  } catch {
    // ignore
  }
  return 'name-asc';
};

export const saveSortPreference = (sort: SortKey): void => {
  localStorage.setItem(SORT_PREFERENCE_KEY, sort);
};

export const collapsedSections = loadCollapsedSections();

export const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1';
export const storageOptions = isDemoMode ? { storageKey: DEMO_STORAGE_KEY } : undefined;

export const state: AppState = {
  me: null,
  guilds: [],
  guildListLoaded: false,
  userData: loadUserData(storageOptions),
  activeFilters: new Set<FilterKey>(),
  search: '',
  sort: loadSortPreference(),
  selectionMode: false,
  selectedIds: new Set<string>(),
};

const _builtinSections: Record<string, SectionElements> = {};
const _dynamicSections: Record<string, SectionElements> = {};

const getBuiltinSection = (key: BuiltinSectionKey): SectionElements => {
  if (!_builtinSections[key]) {
    _builtinSections[key] = {
      section: getElement<HTMLElement>(`${key}-section`),
      list: getElement<HTMLElement>(`${key}-list`),
      count: getElement<HTMLElement>(`${key}-count`),
      content: getElement<HTMLElement>(`${key}-content`),
      header: getElement<HTMLButtonElement>(`[data-collapse-toggle="${key}"]`),
    };
  }
  return _builtinSections[key];
};

export const getSections = (): Record<string, SectionElements> => {
  const sections: Record<string, SectionElements> = {};
  for (const key of BUILTIN_SECTIONS) {
    sections[key] = getBuiltinSection(key);
  }
  for (const [key, el] of Object.entries(_dynamicSections)) {
    sections[key] = el;
  }
  return sections;
};

export const registerDynamicSection = (key: DynamicSectionKey, elements: SectionElements): void => {
  _dynamicSections[key] = elements;
};

export const clearDynamicSections = (): void => {
  for (const key of Object.keys(_dynamicSections)) {
    delete _dynamicSections[key];
  }
};
