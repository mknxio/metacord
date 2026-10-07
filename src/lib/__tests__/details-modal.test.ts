import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, fetchGuildMember: vi.fn(), fetchWidget: vi.fn() };
});

import {
  AccountMismatchError,
  AuthError,
  RateLimitError,
  fetchGuildMember,
  fetchWidget,
  type ApiGuild,
  type ApiGuildMember,
} from '../api';
import { activateAccount } from '../account';
import { state, storageOptions } from '../state';
import {
  confirmForget,
  initAccountMismatch,
  initDetailsModal,
  initShowToast,
  initWidgetRateLimit,
  openDetails,
  render,
} from '../render';
import { accountStorageKey, createDefaultUserData, reconcileServerSnapshots, type UserDataStore } from '../storage';

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';
const ACCOUNT = '1000';
const LIVE_ID = '111';
const DEPARTED_ID = '222';

const liveGuild: ApiGuild = {
  id: LIVE_ID,
  name: 'Live Server',
  icon: null,
  banner: null,
  owner: false,
  features: [],
  approximate_member_count: 120,
  approximate_presence_count: 30,
};

const member: ApiGuildMember = {
  guild_id: LIVE_ID,
  joined_at: '2024-01-02T00:00:00.000Z',
  roles: ['r1', 'r2', 'r3'],
  nickname: 'Nick',
};

const mockedFetchGuildMember = vi.mocked(fetchGuildMember);
const mockedFetchWidget = vi.mocked(fetchWidget);
const modal = { open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => true) };
const rateLimit = { isActive: vi.fn(() => false), report: vi.fn() };

/** A live server plus a departed one that was saved (membership, counts, invite) before leaving. */
const seedUserData = (): UserDataStore => {
  const departedGuild: ApiGuild = { ...liveGuild, id: DEPARTED_ID, name: 'Gone Server' };
  let data = reconcileServerSnapshots(createDefaultUserData(), [liveGuild, departedGuild], T1);
  data = {
    ...data,
    notes: { [DEPARTED_ID]: 'kept note' },
    nicknames: { [DEPARTED_ID]: 'Old Haunt' },
    favorites: [DEPARTED_ID],
    servers: {
      ...data.servers,
      [DEPARTED_ID]: {
        ...data.servers[DEPARTED_ID],
        membership: { joinedAt: '2023-05-06T00:00:00.000Z', nickname: 'Ghost', roleCount: 4, capturedAt: T1 },
        invite: { url: 'https://discord.gg/rejoin', source: 'manual', capturedAt: T1 },
        savedAt: T1,
        departureReason: 'Too noisy',
      },
    },
  };
  return reconcileServerSnapshots(data, [liveGuild], T2);
};

const detailsBody = (): HTMLElement => document.getElementById('details-body') as HTMLElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const openLiveDetails = async () => {
  await openDetails(LIVE_ID);
  const section = detailsBody().querySelector<HTMLElement>('.save-later');
  if (!section) throw new Error('Save for later section missing');
  return {
    button: section.querySelector<HTMLButtonElement>('button') as HTMLButtonElement,
    inviteInput: section.querySelector<HTMLInputElement>('#invite-input') as HTMLInputElement,
    inviteError: section.querySelector<HTMLElement>('#invite-error') as HTMLElement,
    reasonInput: section.querySelector<HTMLTextAreaElement>('#departure-reason-input') as HTMLTextAreaElement,
  };
};

const clickAndSettle = async (button: HTMLButtonElement): Promise<void> => {
  button.click();
  await flush();
  await flush();
};

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  initDetailsModal(modal);
  initWidgetRateLimit(rateLimit);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Signed in: saves go to this account's key.
  activateAccount(ACCOUNT, () => {});
  rateLimit.isActive.mockReturnValue(false);
  mockedFetchGuildMember.mockResolvedValue(member);
  state.guilds = [liveGuild];
  state.guildListLoaded = true;
  state.userData = seedUserData();
  state.search = '';
  state.activeFilters.clear();
  state.selectionMode = false;
  state.selectedIds.clear();
  document.getElementById('login-screen')?.classList.add('hidden');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Save for later', () => {
  it('captures membership, counts, a pasted invite and the reason, then offers a refresh', async () => {
    state.userData = {
      ...state.userData,
      widgetCache: { [LIVE_ID]: { instantInvite: 'https://discord.gg/widget', presenceCount: 5, lastCached: T1 } },
    };
    const { button, inviteInput, reasonInput } = await openLiveDetails();
    expect(button.textContent).toBe('Save for later');

    inviteInput.value = 'https://discord.com/invite/Pasted';
    reasonInput.value = 'Might leave after the event';
    await clickAndSettle(button);

    const snapshot = state.userData.servers[LIVE_ID];
    expect(snapshot.savedAt).not.toBeNull();
    expect(snapshot.membership).toMatchObject({ joinedAt: member.joined_at, nickname: 'Nick', roleCount: 3 });
    expect(snapshot.approximateMemberCount).toBe(120);
    expect(snapshot.approximatePresenceCount).toBe(30);
    // A pasted invite wins over the widget invite; no widget request is made.
    expect(snapshot.invite).toMatchObject({ url: 'https://discord.com/invite/Pasted', source: 'manual' });
    expect(snapshot.departureReason).toBe('Might leave after the event');
    expect(mockedFetchWidget).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Refresh capture');
  });

  it('uses the cached widget invite when nothing is pasted', async () => {
    state.userData = {
      ...state.userData,
      widgetCache: { [LIVE_ID]: { instantInvite: 'https://discord.gg/widget', presenceCount: 5, lastCached: T1 } },
    };
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(state.userData.servers[LIVE_ID].invite).toMatchObject({ url: 'https://discord.gg/widget', source: 'widget' });
    expect(mockedFetchWidget).not.toHaveBeenCalled();
  });

  it('makes exactly one widget request when no invite is cached', async () => {
    mockedFetchWidget.mockResolvedValue({
      id: LIVE_ID,
      name: 'Live Server',
      instant_invite: 'https://discord.gg/fresh',
      presence_count: 12,
    } as Awaited<ReturnType<typeof fetchWidget>>);
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(mockedFetchWidget).toHaveBeenCalledTimes(1);
    expect(mockedFetchWidget).toHaveBeenCalledWith(LIVE_ID);
    expect(state.userData.servers[LIVE_ID].invite).toMatchObject({ url: 'https://discord.gg/fresh', source: 'widget' });
    expect(state.userData.widgetCache[LIVE_ID]?.instantInvite).toBe('https://discord.gg/fresh');
  });

  it('still saves without an invite when the widget request is rate limited, and reports the window', async () => {
    mockedFetchWidget.mockRejectedValue(new RateLimitError(30));
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(state.userData.servers[LIVE_ID].savedAt).not.toBeNull();
    expect(state.userData.servers[LIVE_ID].invite).toBeNull();
    expect(rateLimit.report).toHaveBeenCalledWith(30);
  });

  it('skips the widget request while a rate-limit window is active', async () => {
    rateLimit.isActive.mockReturnValue(true);
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(mockedFetchWidget).not.toHaveBeenCalled();
    expect(state.userData.servers[LIVE_ID].savedAt).not.toBeNull();
    expect(state.userData.servers[LIVE_ID].invite).toBeNull();
  });

  it('still saves without an invite when the widget is unavailable', async () => {
    mockedFetchWidget.mockRejectedValue(new Error('Request failed: 403'));
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(state.userData.servers[LIVE_ID].savedAt).not.toBeNull();
    expect(state.userData.servers[LIVE_ID].invite).toBeNull();
  });

  it('routes to login and saves nothing when the session expired', async () => {
    mockedFetchWidget.mockRejectedValue(new AuthError());
    const before = state.userData;
    const { button } = await openLiveDetails();
    await clickAndSettle(button);
    expect(state.userData).toBe(before);
    expect(document.getElementById('login-screen')?.classList.contains('hidden')).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.example/invite/abc',
    'discord.gg/',
  ])('rejects an invalid pasted invite (%s) without saving or calling Discord', async (pasted) => {
    const before = state.userData;
    const { button, inviteInput, inviteError } = await openLiveDetails();
    inviteInput.value = pasted;
    await clickAndSettle(button);
    expect(inviteInput.getAttribute('aria-invalid')).toBe('true');
    expect(inviteError.textContent).not.toBe('');
    expect(state.userData).toBe(before);
    expect(mockedFetchWidget).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Save for later');
  });
});

describe('membership capture timestamps', () => {
  const OPENED_AT = '2026-10-05T09:00:00.000Z';
  const CLICKED_AT = '2026-10-05T09:30:00.000Z';
  const oldMembership = { joinedAt: '2024-01-02T00:00:00.000Z', nickname: 'Old Nick', roleCount: 1, capturedAt: T1 };

  const seedSavedLive = () => {
    state.userData = {
      ...state.userData,
      servers: {
        ...state.userData.servers,
        [LIVE_ID]: { ...state.userData.servers[LIVE_ID], savedAt: T1, membership: oldMembership },
      },
    };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(OPENED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dates a first save\'s membership by when the modal received it', async () => {
    const { button } = await openLiveDetails();
    vi.setSystemTime(new Date(CLICKED_AT));
    await clickAndSettle(button);
    expect(mockedFetchGuildMember).toHaveBeenCalledTimes(1);
    expect(state.userData.servers[LIVE_ID].membership).toMatchObject({ nickname: 'Nick', capturedAt: OPENED_AT });
    expect(state.userData.servers[LIVE_ID].savedAt).toBe(CLICKED_AT);
  });

  it('fetches membership again on Refresh capture and saves the fresh response', async () => {
    seedSavedLive();
    const { button } = await openLiveDetails();
    expect(button.textContent).toBe('Refresh capture');
    mockedFetchGuildMember.mockResolvedValueOnce({ ...member, nickname: 'Fresh Nick', roles: ['r1'] });
    vi.setSystemTime(new Date(CLICKED_AT));
    await clickAndSettle(button);
    expect(mockedFetchGuildMember).toHaveBeenCalledTimes(2);
    expect(state.userData.servers[LIVE_ID].membership).toEqual({
      joinedAt: member.joined_at,
      nickname: 'Fresh Nick',
      roleCount: 1,
      capturedAt: CLICKED_AT,
    });
  });

  it('keeps the previous capture and its timestamp when the refresh fetch fails', async () => {
    seedSavedLive();
    const { button } = await openLiveDetails();
    mockedFetchGuildMember.mockRejectedValueOnce(new Error('Request failed: 500'));
    vi.setSystemTime(new Date(CLICKED_AT));
    await clickAndSettle(button);
    expect(mockedFetchGuildMember).toHaveBeenCalledTimes(2);
    expect(state.userData.servers[LIVE_ID].membership).toEqual(oldMembership);
    expect(state.userData.servers[LIVE_ID].savedAt).toBe(T1);
  });

  it('routes to login when the refresh fetch finds the session expired', async () => {
    seedSavedLive();
    const before = state.userData;
    const { button } = await openLiveDetails();
    mockedFetchGuildMember.mockRejectedValueOnce(new AuthError());
    await clickAndSettle(button);
    expect(state.userData).toBe(before);
    expect(document.getElementById('login-screen')?.classList.contains('hidden')).toBe(false);
  });
});

describe('a departure noticed by another tab', () => {
  const toast = { show: vi.fn(), dismiss: vi.fn() };

  /** This tab still lists the server, but storage (via the watcher) says it departed. */
  const markDepartedElsewhere = (savedAt: string | null) => {
    state.userData = {
      ...state.userData,
      servers: {
        ...state.userData.servers,
        [LIVE_ID]: { ...state.userData.servers[LIVE_ID], savedAt, departedAt: T2, lastSeenAt: T1 },
      },
    };
  };

  beforeEach(() => {
    const appShell = document.getElementById('app-shell') as HTMLElement;
    appShell.setAttribute('aria-hidden', 'false');
    initShowToast(toast as unknown as Parameters<typeof initShowToast>[0], appShell);
  });

  it('keeps the departure and says so when the membership refresh fails', async () => {
    const { button } = await openLiveDetails();
    markDepartedElsewhere(T1);
    const before = state.userData;
    mockedFetchGuildMember.mockRejectedValueOnce(new Error('Request failed: 404'));
    await clickAndSettle(button);

    expect(state.userData).toBe(before);
    expect(state.userData.servers[LIVE_ID]).toMatchObject({ departedAt: T2, lastSeenAt: T1 });
    expect(toast.show).toHaveBeenCalledWith(
      'This server is no longer in your server list. Nothing was saved.',
      { variant: 'error' },
    );
  });

  it('checks membership again for a first save and revives the server when that succeeds', async () => {
    const { button } = await openLiveDetails();
    markDepartedElsewhere(null);
    await clickAndSettle(button);

    expect(mockedFetchGuildMember).toHaveBeenCalledTimes(2);
    expect(state.userData.servers[LIVE_ID].departedAt).toBeNull();
    expect(state.userData.servers[LIVE_ID].savedAt).not.toBeNull();
  });
});

describe('account changes while requests are pending', () => {
  const OTHER = '2000';
  const onMismatch = vi.fn();
  const storedEntries = () =>
    [...Array(localStorage.length).keys()].map((index) => {
      const key = localStorage.key(index) as string;
      return [key, localStorage.getItem(key)];
    });

  beforeEach(() => {
    onMismatch.mockClear();
    initAccountMismatch(onMismatch);
  });

  it('rejects member details issued for another account and saves nothing', async () => {
    state.userData = {
      ...state.userData,
      servers: { ...state.userData.servers, [LIVE_ID]: { ...state.userData.servers[LIVE_ID], savedAt: T1 } },
    };
    const before = state.userData;
    const { button } = await openLiveDetails();
    expect(mockedFetchGuildMember).toHaveBeenCalledWith(LIVE_ID, ACCOUNT);
    mockedFetchGuildMember.mockRejectedValueOnce(new AccountMismatchError(ACCOUNT, OTHER));
    const stored = storedEntries();
    await clickAndSettle(button);

    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(state.userData).toBe(before);
    expect(storedEntries()).toEqual(stored);
  });

  it('drops a capture whose requests resolve after the account changed', async () => {
    let resolveWidget: (value: Awaited<ReturnType<typeof fetchWidget>>) => void = () => {};
    mockedFetchWidget.mockImplementation(() => new Promise((resolve) => (resolveWidget = resolve)));
    const { button } = await openLiveDetails();
    button.click();
    await flush();

    activateAccount(OTHER, () => {});
    const otherData = state.userData;
    const stored = storedEntries();
    resolveWidget({ instant_invite: 'https://discord.gg/late', presence_count: 3 } as Awaited<
      ReturnType<typeof fetchWidget>
    >);
    await flush();
    await flush();

    expect(state.userData).toBe(otherData);
    expect(state.userData.servers[LIVE_ID]).toBeUndefined();
    expect(storedEntries()).toEqual(stored);
  });

  it('renders nothing when the member response arrives after the account changed', async () => {
    let resolveMember: (value: ApiGuildMember) => void = () => {};
    mockedFetchGuildMember.mockImplementationOnce(() => new Promise((resolve) => (resolveMember = resolve)));
    const pending = openDetails(LIVE_ID);
    activateAccount(OTHER, () => {});
    state.guilds = [liveGuild];
    resolveMember(member);
    await pending;
    expect(detailsBody().querySelector('.save-later')).toBeNull();
    expect(detailsBody().textContent).not.toContain('Nick');
  });
});

describe('departed details modal', () => {
  it('shows captured data without calling live Discord endpoints', async () => {
    await openDetails(DEPARTED_ID);
    expect(mockedFetchGuildMember).not.toHaveBeenCalled();
    expect(mockedFetchWidget).not.toHaveBeenCalled();
    expect(modal.open).toHaveBeenCalled();

    const text = detailsBody().textContent ?? '';
    expect(text).toContain('Gone Server');
    expect(text).toContain('Left (noticed)');
    expect(text).toContain('Server nickname: Ghost');
    expect(text).toContain('Roles: 4');
    expect(text).toContain('Members: 120');
    expect(text).toContain('Online: 30');
    expect(detailsBody().querySelector<HTMLTextAreaElement>('#notes-input')?.value).toBe('kept note');
    expect(detailsBody().querySelector<HTMLTextAreaElement>('#departure-reason-input')?.value).toBe('Too noisy');

    const rejoin = detailsBody().querySelector<HTMLAnchorElement>('a.btn');
    expect(rejoin?.textContent).toBe('Rejoin');
    expect(rejoin?.getAttribute('href')).toBe('https://discord.gg/rejoin');
    expect(rejoin?.target).toBe('_blank');
    expect(rejoin?.rel).toBe('noopener noreferrer');
    expect(detailsBody().querySelector('.save-later')).toBeNull();
  });

  it('never renders an imported non-Discord invite as a link', async () => {
    state.userData = {
      ...state.userData,
      servers: {
        ...state.userData.servers,
        [DEPARTED_ID]: {
          ...state.userData.servers[DEPARTED_ID],
          invite: { url: 'javascript:alert(1)', source: 'manual', capturedAt: T1 },
        },
      },
    };
    await openDetails(DEPARTED_ID);
    expect(detailsBody().querySelector('a')).toBeNull();
    expect(detailsBody().textContent).toContain('No rejoin invite was captured.');
  });

  it('offers Forget only for departed servers', async () => {
    await openDetails(DEPARTED_ID);
    const departedButtons = [...detailsBody().querySelectorAll('button')].map((button) => button.textContent);
    expect(departedButtons).toContain('Forget');

    await openDetails(LIVE_ID);
    const liveButtons = [...detailsBody().querySelectorAll('button')].map((button) => button.textContent);
    expect(liveButtons).not.toContain('Forget');
  });
});

describe('section cards', () => {
  const cardFor = (guildId: string): HTMLElement =>
    document.querySelector<HTMLElement>(`.server-card[data-guild-id="${guildId}"]`) as HTMLElement;
  const buttonLabels = (card: HTMLElement): string[] =>
    [...card.querySelectorAll('button')].map((button) => button.textContent ?? '');

  it('renders Forget and Rejoin only on departed cards', () => {
    render();
    const live = cardFor(LIVE_ID);
    const departed = cardFor(DEPARTED_ID);
    expect(live.closest('#departed-section')).toBeNull();
    expect(departed.closest('#departed-section')).not.toBeNull();
    expect(buttonLabels(live)).not.toContain('Forget');
    expect(buttonLabels(departed)).toContain('Forget');
    expect(departed.querySelector('a')?.getAttribute('href')).toBe('https://discord.gg/rejoin');
  });

  it('excludes departed cards from bulk selection', () => {
    state.selectionMode = true;
    render();
    expect(cardFor(LIVE_ID).getAttribute('role')).toBe('checkbox');
    expect(cardFor(DEPARTED_ID).getAttribute('role')).toBe('button');
  });
});

describe('confirmForget', () => {
  it('leaves data untouched when the confirmation is cancelled', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = state.userData;
    expect(confirmForget(DEPARTED_ID)).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(state.userData).toBe(before);
  });

  it('removes the snapshot and every annotation after confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(confirmForget(DEPARTED_ID)).toBe(true);
    expect(state.userData.servers[DEPARTED_ID]).toBeUndefined();
    expect(state.userData.notes[DEPARTED_ID]).toBeUndefined();
    expect(state.userData.nicknames[DEPARTED_ID]).toBeUndefined();
    expect(state.userData.favorites).not.toContain(DEPARTED_ID);
    expect(state.userData.servers[LIVE_ID]).toBeDefined();
  });

  it('never asks to forget a live server', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const before = state.userData;
    expect(confirmForget(LIVE_ID)).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(state.userData).toBe(before);
  });
});
