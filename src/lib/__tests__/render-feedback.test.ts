import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

// state.ts loads user data at import time; give it a working localStorage first.
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

import type { ApiGuild } from '../api';
import { state } from '../state';
import { render } from '../render';
import { createDefaultUserData, reconcileServerSnapshots } from '../storage';

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';

const guild = (id: string, name: string): ApiGuild => ({
  id,
  name,
  icon: null,
  banner: null,
  owner: false,
  features: [],
});

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

/** Observed `observed` once, then only `current` remain: the rest are departed. */
const seed = (observed: ApiGuild[], current: ApiGuild[]): void => {
  const first = reconcileServerSnapshots(createDefaultUserData(), observed, T1);
  state.guilds = current;
  state.guildListLoaded = true;
  state.userData = reconcileServerSnapshots(first, current, T2);
};

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
});

beforeEach(() => {
  state.search = '';
  state.activeFilters.clear();
  state.selectionMode = false;
  state.selectedIds.clear();
});

describe('search feedback', () => {
  it('counts matching departed cards against a total that includes departed servers', () => {
    const alpha = guild('1', 'Alpha Live');
    const beta = guild('2', 'Beta Live');
    seed([alpha, beta, guild('3', 'Alpha Gone'), guild('4', 'Gamma Gone')], [alpha, beta]);

    state.search = 'alpha';
    render();
    expect(byId('filter-count').textContent).toBe('2 of 4 servers');
    expect(byId('filter-count').classList.contains('hidden')).toBe(false);

    state.search = 'gamma';
    render();
    expect(byId('filter-count').textContent).toBe('1 of 4 servers');
  });
});

describe('empty state', () => {
  it('stays hidden when only departed servers render', () => {
    seed([guild('3', 'Gone')], []);
    render();
    expect(byId('departed-section').classList.contains('hidden')).toBe(false);
    expect(byId('empty-state').classList.contains('hidden')).toBe(true);
  });

  it('shows when there are no servers at all', () => {
    seed([], []);
    render();
    expect(byId('empty-state').classList.contains('hidden')).toBe(false);
  });
});
