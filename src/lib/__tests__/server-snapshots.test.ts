import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDefaultUserData,
  discardUnsupportedBackups,
  exportUserData,
  forgetServer,
  importUserData,
  isUserDataWriteBlocked,
  listUnpreservedPayloads,
  listUnsupportedBackups,
  loadUserData,
  reconcileServerSnapshots,
  releaseUnpreservedPayload,
  saveServerCapture,
  saveUserData,
  toggleFavorite,
  unsupportedBackupKey,
  updateDepartureReason,
  updateNotes,
  UnsupportedUserDataVersionError,
  type ObservedGuild,
  type ServerSnapshot,
  type UserDataStore,
} from '../storage';

const TEST_KEY = '__test_snapshot_key__';
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

beforeEach(() => {
  vi.stubGlobal('localStorage', createLocalStorageMock());
});

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';
const T3 = '2026-10-03T10:00:00.000Z';

const guild = (id: string, overrides: Partial<ObservedGuild> = {}): ObservedGuild => ({
  id,
  name: `Server ${id}`,
  icon: `icon-${id}`,
  banner: null,
  owner: false,
  features: ['COMMUNITY'],
  approximate_member_count: 120,
  approximate_presence_count: 30,
  ...overrides,
});

describe('reconcileServerSnapshots', () => {
  it('upserts a snapshot for every guild in the list', () => {
    const data = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
    expect(Object.keys(data.servers)).toEqual(['1', '2']);
    expect(data.servers['1']).toEqual<ServerSnapshot>({
      id: '1',
      name: 'Server 1',
      icon: 'icon-1',
      banner: null,
      owner: false,
      features: ['COMMUNITY'],
      firstSeenAt: T1,
      lastSeenAt: T1,
      approximateMemberCount: 120,
      approximatePresenceCount: 30,
      membership: null,
      invite: null,
      savedAt: null,
      departedAt: null,
      departureReason: null,
    });
  });

  it('keeps firstSeenAt and refreshes name, icon, counts and lastSeenAt on later loads', () => {
    const first = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    const second = reconcileServerSnapshots(
      first,
      [guild('1', { name: 'Renamed', icon: 'new-icon', approximate_member_count: 200 })],
      T2,
    );
    expect(second.servers['1']).toMatchObject({
      name: 'Renamed',
      icon: 'new-icon',
      approximateMemberCount: 200,
      firstSeenAt: T1,
      lastSeenAt: T2,
    });
  });

  it('keeps the last known counts when a response omits them', () => {
    const first = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    const second = reconcileServerSnapshots(
      first,
      [guild('1', { approximate_member_count: undefined, approximate_presence_count: undefined })],
      T2,
    );
    expect(second.servers['1'].approximateMemberCount).toBe(120);
    expect(second.servers['1'].approximatePresenceCount).toBe(30);
  });

  it('marks snapshots absent from the list as departed and keeps everything else', () => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
    data = { ...data, notes: { '2': 'remember me' }, favorites: ['2'] };
    const next = reconcileServerSnapshots(data, [guild('1')], T2);
    expect(next.servers['2']).toMatchObject({ name: 'Server 2', departedAt: T2, lastSeenAt: T1 });
    expect(next.servers['1'].departedAt).toBeNull();
    expect(next.notes).toEqual({ '2': 'remember me' });
    expect(next.favorites).toEqual(['2']);
  });

  it('keeps the original detected departure date on later loads', () => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('1'), guild('2')], T1);
    data = reconcileServerSnapshots(data, [guild('1')], T2);
    data = reconcileServerSnapshots(data, [guild('1')], T3);
    expect(data.servers['2'].departedAt).toBe(T2);
  });

  it('clears the departure when a departed server reappears, keeping annotations and captures', () => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    data = saveServerCapture(
      data,
      guild('1'),
      {
        membership: { joinedAt: '2020-01-01T00:00:00.000Z', nickname: 'me', roleCount: 2, capturedAt: T1 },
        invite: { url: 'https://discord.gg/abc123', source: 'manual', capturedAt: T1 },
        departureReason: 'too noisy',
      },
      T1,
      opts,
    );
    data = { ...data, nicknames: { '1': 'Nick' }, serverCategories: { '1': 'cat' } };
    data = reconcileServerSnapshots(data, [], T2);
    expect(data.servers['1'].departedAt).toBe(T2);
    data = reconcileServerSnapshots(data, [guild('1')], T3);
    expect(data.servers['1']).toMatchObject({
      departedAt: null,
      lastSeenAt: T3,
      firstSeenAt: T1,
      savedAt: T1,
      departureReason: 'too noisy',
      invite: { url: 'https://discord.gg/abc123', source: 'manual', capturedAt: T1 },
    });
    expect(data.nicknames).toEqual({ '1': 'Nick' });
    expect(data.serverCategories).toEqual({ '1': 'cat' });
  });

  it('recovers annotation-only guild IDs as unknown departed servers', () => {
    const data: UserDataStore = {
      ...createDefaultUserData(),
      favorites: ['fav'],
      nicknames: { nick: 'Old nickname' },
      notes: { note: 'Old note' },
      serverCategories: { cat: 'category-1' },
      widgetCache: { widget: { instantInvite: null, presenceCount: 3, lastCached: T1 } },
    };
    const next = reconcileServerSnapshots(data, [guild('live')], T2);
    for (const id of ['fav', 'nick', 'note', 'cat', 'widget']) {
      expect(next.servers[id]).toMatchObject({
        id,
        name: null,
        departedAt: T2,
        firstSeenAt: null,
        lastSeenAt: null,
      });
    }
    expect(next.servers.live.departedAt).toBeNull();
  });

  it('does not create orphan records for annotations of current servers', () => {
    const data: UserDataStore = { ...createDefaultUserData(), notes: { live: 'note' } };
    const next = reconcileServerSnapshots(data, [guild('live')], T1);
    expect(next.servers.live.name).toBe('Server live');
    expect(next.servers.live.departedAt).toBeNull();
  });

  it('does not mutate its input', () => {
    const data = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    const before = JSON.stringify(data);
    reconcileServerSnapshots(data, [], T2);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe('saveServerCapture', () => {
  it('records membership, invite, counts, reason and savedAt', () => {
    const data = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    const next = saveServerCapture(
      data,
      guild('1', { approximate_member_count: 500 }),
      {
        membership: { joinedAt: '2021-05-05T00:00:00.000Z', nickname: null, roleCount: 4, capturedAt: T2 },
        invite: { url: 'https://discord.com/invite/xyz', source: 'widget', capturedAt: T2 },
        departureReason: '  leaving soon  ',
      },
      T2,
      opts,
    );
    expect(next.servers['1']).toMatchObject({
      savedAt: T2,
      approximateMemberCount: 500,
      departureReason: 'leaving soon',
      membership: { roleCount: 4, capturedAt: T2 },
      invite: { url: 'https://discord.com/invite/xyz', source: 'widget' },
    });
    expect(loadUserData(opts).servers['1'].savedAt).toBe(T2);
  });

  it('keeps the original savedAt and previous captures when refreshing without new data', () => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    data = saveServerCapture(
      data,
      guild('1'),
      {
        membership: { joinedAt: null, nickname: 'n', roleCount: 1, capturedAt: T1 },
        invite: { url: 'https://discord.gg/keep', source: 'manual', capturedAt: T1 },
        departureReason: null,
      },
      T1,
      opts,
    );
    const next = saveServerCapture(data, guild('1'), { membership: null, invite: null, departureReason: '' }, T2, opts);
    expect(next.servers['1'].savedAt).toBe(T1);
    expect(next.servers['1'].membership?.capturedAt).toBe(T1);
    expect(next.servers['1'].invite?.url).toBe('https://discord.gg/keep');
    expect(next.servers['1'].departureReason).toBeNull();
  });
});

describe('updateDepartureReason', () => {
  it('sets and clears the reason on an existing snapshot', () => {
    const data = reconcileServerSnapshots(createDefaultUserData(), [guild('1')], T1);
    const withReason = updateDepartureReason(data, '1', ' spam ', opts);
    expect(withReason.servers['1'].departureReason).toBe('spam');
    expect(updateDepartureReason(withReason, '1', '   ', opts).servers['1'].departureReason).toBeNull();
  });

  it('ignores unknown guild IDs', () => {
    const data = createDefaultUserData();
    expect(updateDepartureReason(data, 'missing', 'x', opts)).toBe(data);
  });
});

describe('forgetServer', () => {
  const departedData = (): UserDataStore => {
    let data = reconcileServerSnapshots(createDefaultUserData(), [guild('gone'), guild('stay')], T1);
    data = {
      ...data,
      favorites: ['gone', 'stay'],
      nicknames: { gone: 'G', stay: 'S' },
      notes: { gone: 'g', stay: 's' },
      serverCategories: { gone: 'c', stay: 'c' },
      widgetCache: {
        gone: { instantInvite: null, presenceCount: 1, lastCached: T1 },
        stay: { instantInvite: null, presenceCount: 1, lastCached: T1 },
      },
    };
    return reconcileServerSnapshots(data, [guild('stay')], T2);
  };

  it('removes the snapshot and every annotation keyed by the departed ID', () => {
    const next = forgetServer(departedData(), 'gone', opts);
    expect(next.servers.gone).toBeUndefined();
    expect(next.favorites).toEqual(['stay']);
    expect(next.nicknames).toEqual({ stay: 'S' });
    expect(next.notes).toEqual({ stay: 's' });
    expect(next.serverCategories).toEqual({ stay: 'c' });
    expect(Object.keys(next.widgetCache)).toEqual(['stay']);
    expect(next.servers.stay).toBeDefined();
    expect(loadUserData(opts).servers.gone).toBeUndefined();
  });

  it('refuses to forget a server that is not departed', () => {
    const data = departedData();
    expect(forgetServer(data, 'stay', opts)).toBe(data);
  });

  it('refuses to forget an unknown ID', () => {
    const data = departedData();
    expect(forgetServer(data, 'nope', opts)).toBe(data);
  });
});

describe('schema v3 migration and portability', () => {
  const v2Payload = {
    version: 2,
    favorites: ['g1'],
    nicknames: { g1: 'Nick' },
    notes: { g1: 'Note', g2: 'Orphan note' },
    widgetCache: { g1: { instantInvite: 'https://discord.gg/abc', presenceCount: 5, lastCached: T1 } },
    lastFetchTimestamp: T1,
    categories: [{ id: 'cat-1', name: 'Gaming', order: 0 }],
    serverCategories: { g1: 'cat-1' },
  };

  it('loads a v2 localStorage payload as v3 without losing any field', () => {
    localStorage.setItem(TEST_KEY, JSON.stringify(v2Payload));
    expect(loadUserData(opts)).toEqual({ ...v2Payload, version: 3, servers: {} });
  });

  it('imports a v2 export file as v3 without losing any field', () => {
    const exported = JSON.stringify(v2Payload, null, 2);
    const imported = importUserData(JSON.parse(exported), opts);
    expect(imported).toEqual({ ...v2Payload, version: 3, servers: {} });
    expect(loadUserData(opts)).toEqual(imported);
  });

  it('exports v3', () => {
    expect(JSON.parse(exportUserData(createDefaultUserData())).version).toBe(3);
  });

  it('rejects importing a newer version without touching stored data', () => {
    const existing = { ...createDefaultUserData(), favorites: ['keep'] };
    localStorage.setItem(TEST_KEY, JSON.stringify(existing));
    expect(() => importUserData({ ...v2Payload, version: 4 }, opts)).toThrow(UnsupportedUserDataVersionError);
    expect(loadUserData(opts).favorites).toEqual(['keep']);
  });

  it('backs up a newer stored payload instead of silently downgrading it', () => {
    const newer = JSON.stringify({ ...v2Payload, version: 99, futureField: true });
    localStorage.setItem(TEST_KEY, newer);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = loadUserData(opts);
    expect(data).toEqual(createDefaultUserData());
    expect(localStorage.getItem(unsupportedBackupKey(opts))).toBe(newer);
  });

  it('keeps every distinct newer payload and lists them for the user', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = JSON.stringify({ ...v2Payload, version: 4, favorites: ['first'] });
    const second = JSON.stringify({ ...v2Payload, version: 5, favorites: ['second'] });

    localStorage.setItem(TEST_KEY, first);
    loadUserData(opts);
    // The app then saves over the main key (reconcile, edits)...
    saveUserData(createDefaultUserData(), opts);
    // ...and a later rollback leaves a different newer payload behind.
    localStorage.setItem(TEST_KEY, second);
    loadUserData(opts);
    // Reloading again with the same payload does not duplicate the backup.
    loadUserData(opts);

    const backups = listUnsupportedBackups(opts);
    expect(backups.map((backup) => backup.payload)).toEqual([first, second]);
    expect(backups.map((backup) => backup.version)).toEqual([4, 5]);
    expect(backups[0].key).toBe(unsupportedBackupKey(opts));

    discardUnsupportedBackups(opts);
    expect(listUnsupportedBackups(opts)).toEqual([]);
  });

  it('drops invite URLs that are not Discord invites when importing', () => {
    const payload = {
      ...createDefaultUserData(),
      servers: {
        evil: {
          id: 'evil',
          name: 'Evil',
          invite: { url: 'javascript:alert(1)', source: 'manual', capturedAt: T1 },
          departedAt: T1,
        },
      },
    };
    const imported = importUserData(payload, opts);
    expect(imported.servers.evil.invite).toBeNull();
    expect(imported.servers.evil.name).toBe('Evil');
  });

  it('rejects a non-object servers field', () => {
    expect(() => importUserData({ ...createDefaultUserData(), servers: [] }, opts)).toThrow(
      'Invalid user data format',
    );
  });

  it('round-trips a v3 export through import byte for byte', () => {
    let data: UserDataStore = {
      ...createDefaultUserData(),
      ...v2Payload,
      version: 3,
      servers: {},
    };
    data = reconcileServerSnapshots(data, [guild('g1', { banner: 'banner-hash', owner: true })], T1);
    data = saveServerCapture(
      data,
      guild('g1', { banner: 'banner-hash', owner: true }),
      {
        membership: { joinedAt: '2019-02-03T04:05:06.000Z', nickname: 'Server nick', roleCount: 7, capturedAt: T2 },
        invite: { url: 'https://discord.gg/abc', source: 'widget', capturedAt: T2 },
        departureReason: 'Taking a break',
      },
      T2,
      opts,
    );
    data = reconcileServerSnapshots(data, [], T3);

    const exported = exportUserData(data);
    const reimported = importUserData(JSON.parse(exported), opts);
    expect(exportUserData(reimported)).toBe(exported);
    expect(reimported).toEqual(data);
    expect(reimported.servers.g1.departedAt).toBe(T3);
    expect(reimported.servers.g2.name).toBeNull();
  });
});

// The write block is module state keyed by storage key, so each test uses its own key.
describe('newer-version data that cannot be backed up', () => {
  const newer = JSON.stringify({ version: 9, favorites: ['future'], notes: { g1: 'irreplaceable' } });

  const failBackupWrites = () => {
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes('_unsupported_backup')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      setItem(key, value);
    });
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('never lets a later save overwrite the only copy', () => {
    const options = { storageKey: '__test_unpreserved_block__' };
    localStorage.setItem(options.storageKey, newer);
    failBackupWrites();

    let data = loadUserData(options);
    expect(data).toEqual(createDefaultUserData());
    expect(listUnsupportedBackups(options)).toEqual([]);
    expect(isUserDataWriteBlocked(options)).toBe(true);
    expect(listUnpreservedPayloads(options)).toEqual([{ key: options.storageKey, payload: newer, version: 9 }]);

    data = reconcileServerSnapshots(data, [guild('g1')], T1);
    saveUserData(data, options);
    data = toggleFavorite(data, 'g1', options);
    data = updateNotes(data, 'g1', 'new note', options);

    // Edits stay in memory for the session; storage still holds the newer payload.
    expect(data.notes.g1).toBe('new note');
    expect(localStorage.getItem(options.storageKey)).toBe(newer);
  });

  it('blocks only the storage key whose payload could not be preserved', () => {
    const blocked = { storageKey: '__test_unpreserved_main__' };
    const demo = { storageKey: '__test_unpreserved_demo__' };
    localStorage.setItem(blocked.storageKey, newer);
    failBackupWrites();
    loadUserData(blocked);

    saveUserData({ ...createDefaultUserData(), favorites: ['demo'] }, demo);
    expect(isUserDataWriteBlocked(demo)).toBe(false);
    expect(loadUserData(demo).favorites).toEqual(['demo']);
  });

  it('resumes saving once the payload is downloaded, without blocking again on reload', () => {
    const options = { storageKey: '__test_unpreserved_release__' };
    localStorage.setItem(options.storageKey, newer);
    failBackupWrites();
    loadUserData(options);

    releaseUnpreservedPayload(newer, options);
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(localStorage.getItem(options.storageKey)).toBe(newer);

    // Reloading the same payload in this session (demo mode reloads) stays unblocked.
    loadUserData(options);
    expect(isUserDataWriteBlocked(options)).toBe(false);
    saveUserData({ ...createDefaultUserData(), favorites: ['after'] }, options);
    expect(loadUserData(options).favorites).toEqual(['after']);
  });

  it('removes the payload from the main key when the user discards it', () => {
    const options = { storageKey: '__test_unpreserved_discard__' };
    localStorage.setItem(options.storageKey, newer);
    failBackupWrites();
    loadUserData(options);

    releaseUnpreservedPayload(newer, options, { discard: true });
    expect(isUserDataWriteBlocked(options)).toBe(false);
    expect(localStorage.getItem(options.storageKey)).toBeNull();
  });
});
