import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { state } from '../state';
import {
  buildDepartedViews,
  buildServerViews,
  getSortComparator,
  getVisibleServerIds,
  matchesSearch,
  UNKNOWN_SERVER_NAME,
} from '../render';
import { createDefaultUserData, reconcileServerSnapshots } from '../storage';
import type { ApiGuild } from '../api';

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';

const guild = (id: string, overrides: Partial<ApiGuild> = {}): ApiGuild => ({
  id,
  name: `Server ${id}`,
  icon: null,
  banner: null,
  owner: false,
  features: [],
  ...overrides,
});

beforeEach(() => {
  state.guilds = [];
  state.userData = createDefaultUserData();
  state.search = '';
  state.activeFilters.clear();
});

describe('buildServerViews counts', () => {
  it('prefers guild-list presence counts and falls back to widget presence', () => {
    state.guilds = [
      guild('a', { approximate_presence_count: 50, approximate_member_count: 500 }),
      guild('b'),
    ];
    state.userData = {
      ...createDefaultUserData(),
      widgetCache: {
        a: { instantInvite: null, presenceCount: 5, lastCached: T1 },
        b: { instantInvite: null, presenceCount: 7, lastCached: T1 },
      },
    };
    const [a, b] = buildServerViews();
    expect(a.onlineCount).toBe(50);
    expect(a.memberCount).toBe(500);
    expect(b.onlineCount).toBe(7);
    expect(b.memberCount).toBeNull();
  });

  it('sorts online-desc by guild-list presence for servers without a widget', () => {
    state.guilds = [
      guild('low', { approximate_presence_count: 1 }),
      guild('none'),
      guild('high', { approximate_presence_count: 99 }),
    ];
    const sorted = buildServerViews().sort(getSortComparator('online-desc')).map((view) => view.id);
    expect(sorted).toEqual(['high', 'low', 'none']);
  });

  it('marks saved servers', () => {
    state.guilds = [guild('a')];
    const data = reconcileServerSnapshots(createDefaultUserData(), state.guilds, T1);
    state.userData = { ...data, servers: { a: { ...data.servers.a, savedAt: T1 } } };
    expect(buildServerViews()[0].isSaved).toBe(true);
  });
});

describe('buildDepartedViews', () => {
  const setup = (): void => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('live'), guild('gone')], T1);
    data = {
      ...data,
      notes: { gone: 'gone note', orphan: 'orphan note' },
      favorites: ['gone'],
      categories: [{ id: 'cat', name: 'Games', order: 0 }],
      serverCategories: { gone: 'cat' },
      widgetCache: { gone: { instantInvite: 'javascript:alert(1)', presenceCount: null, lastCached: T1 } },
    };
    state.guilds = [guild('live')];
    state.userData = reconcileServerSnapshots(data, state.guilds, T2);
  };

  it('lists departed and unknown servers with their annotations', () => {
    setup();
    const views = buildDepartedViews();
    const gone = views.find((view) => view.id === 'gone');
    const orphan = views.find((view) => view.id === 'orphan');
    expect(gone).toMatchObject({
      name: 'Server gone',
      notes: 'gone note',
      isFavorite: true,
      departure: { departedAt: T2, isUnknown: false, categoryName: 'Games', inviteUrl: null },
    });
    expect(orphan).toMatchObject({ name: UNKNOWN_SERVER_NAME, departure: { isUnknown: true } });
    expect(views.some((view) => view.id === 'live')).toBe(false);
  });

  it('never exposes an unvalidated invite as the rejoin URL', () => {
    setup();
    expect(buildDepartedViews().find((view) => view.id === 'gone')?.departure?.inviteUrl).toBeNull();
  });

  it('uses the captured invite for Rejoin', () => {
    setup();
    state.userData = {
      ...state.userData,
      servers: {
        ...state.userData.servers,
        gone: {
          ...state.userData.servers.gone,
          invite: { url: 'https://discord.gg/rejoin', source: 'manual', capturedAt: T1 },
        },
      },
    };
    expect(buildDepartedViews().find((view) => view.id === 'gone')?.departure?.inviteUrl).toBe(
      'https://discord.gg/rejoin',
    );
  });

  it('is searchable by name', () => {
    setup();
    const matches = buildDepartedViews().filter((view) => matchesSearch(view, 'gone'));
    expect(matches.map((view) => view.id)).toEqual(['gone']);
  });

  it('is excluded from bulk selection', () => {
    setup();
    expect(getVisibleServerIds()).toEqual(['live']);
  });
});
