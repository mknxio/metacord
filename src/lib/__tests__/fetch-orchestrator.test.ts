import { describe, it, expect, beforeAll, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

// state.ts reads localStorage at import time; give it a working one first.
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
  return { ...actual, fetchWidget: vi.fn() };
});

import { fetchWidget } from '../api';
import { activateAccount } from '../account';
import { initFetchOrchestrator, performWidgetFetch } from '../fetch-orchestrator';
import { state } from '../state';
import { accountStorageKey } from '../storage';

const mockedFetchWidget = vi.mocked(fetchWidget);

beforeAll(() => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  initFetchOrchestrator({ open: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) });
});

describe('performWidgetFetch', () => {
  it('saves nothing when the account changes while widgets load', async () => {
    let resolveWidget: (value: Awaited<ReturnType<typeof fetchWidget>>) => void = () => {};
    mockedFetchWidget.mockImplementation(() => new Promise((resolve) => (resolveWidget = resolve)));
    activateAccount('111', () => {});
    state.guilds = [{ id: '9', name: 'G', icon: null, banner: null, owner: false, features: [] }];

    const run = performWidgetFetch();
    activateAccount('222', () => {});
    const otherData = state.userData;
    resolveWidget({ instant_invite: 'https://discord.gg/x', presence_count: 4 } as Awaited<
      ReturnType<typeof fetchWidget>
    >);
    await run;

    expect(state.userData).toBe(otherData);
    expect(localStorage.getItem(accountStorageKey('222'))).toBeNull();
    expect(localStorage.getItem(accountStorageKey('111'))).toBeNull();
  });
});
