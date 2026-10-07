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

import { AuthError, type ApiGuild } from '../api';
import { syncGuildList } from '../guild-sync';
import { applyGuildSyncOutcome } from '../hydrate';
import { setScreen } from '../render';
import { state, storageOptions } from '../state';
import { createDefaultUserData, reconcileServerSnapshots, saveUserData } from '../storage';

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
const isHidden = (id: string): boolean => byId(id).classList.contains('hidden');
const storageEntries = (): Array<[string, string | null]> =>
  [...Array(localStorage.length).keys()].map((index) => {
    const key = localStorage.key(index) as string;
    return [key, localStorage.getItem(key)];
  });

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
});

/** Stored history from earlier sessions: "Still Here" is current, "Long Gone" departed. */
beforeEach(() => {
  localStorage.clear();
  const observed = reconcileServerSnapshots(
    createDefaultUserData(),
    [guild('1', 'Still Here'), guild('2', 'Long Gone')],
    T1,
  );
  const stored = reconcileServerSnapshots(observed, [guild('1', 'Still Here')], T2);
  saveUserData(stored, storageOptions);
  state.guilds = [];
  state.guildListLoaded = false;
  state.guildListError = false;
  state.userData = stored;
  state.search = '';
  state.activeFilters.clear();
  setScreen('app');
});

describe('applyGuildSyncOutcome when the guild list fails to load', () => {
  it('renders stored history without marking anything departed', async () => {
    const before = state.userData;
    const storedBefore = storageEntries();
    const outcome = await syncGuildList(
      () => Promise.reject(new Error('Request failed: 500')),
      () => state.userData,
      { now: () => '2026-10-03T10:00:00.000Z', storageOptions },
    );
    applyGuildSyncOutcome(outcome);

    expect(isHidden('departed-section')).toBe(false);
    expect(byId('departed-list').textContent).toContain('Long Gone');
    expect(byId('departed-list').textContent).not.toContain('Still Here');
    expect(isHidden('guild-list-error')).toBe(false);
    expect(isHidden('empty-state')).toBe(true);
    expect(state.userData).toBe(before);
    expect(state.userData.servers['1'].departedAt).toBeNull();
    expect(storageEntries()).toEqual(storedBefore);
  });

  it('routes to login when the session expired', async () => {
    const outcome = await syncGuildList(() => Promise.reject(new AuthError()), () => state.userData, {
      storageOptions,
    });
    applyGuildSyncOutcome(outcome);
    expect(isHidden('login-screen')).toBe(false);
    expect(isHidden('app-shell')).toBe(true);
  });

  it('clears the failure message once a later load succeeds', async () => {
    applyGuildSyncOutcome({ ok: false, error: new Error('down'), userData: state.userData });
    const outcome = await syncGuildList(async () => [guild('1', 'Still Here')], () => state.userData, {
      now: () => '2026-10-03T10:00:00.000Z',
      storageOptions,
    });
    applyGuildSyncOutcome(outcome);
    expect(isHidden('guild-list-error')).toBe(true);
    expect(state.guildListLoaded).toBe(true);
  });
});
