import { afterEach, describe, expect, test } from 'bun:test';

import {
  readToolkitPanel,
  subscribeToolkitPanel,
  writeToolkitPanel
} from './toolkit-url-state';

type FakeWindow = {
  location: URL;
  history: {
    state: unknown;
    replaceState(state: unknown, title: string, url: string): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWindow(href = 'http://localhost/toolkit'): { win: FakeWindow; dispatch: (type: string) => void } {
  const location = new URL(href);
  const listeners = new Map<string, Set<() => void>>();
  const win: FakeWindow = {
    location,
    history: {
      state: {},
      replaceState(state, _title, url) {
        location.href = new URL(url, location.href).href;
        win.history.state = state;
      }
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  return {
    win,
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    }
  };
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe('toolkit panel URL state', () => {
  test('reads the panel query parameter and tolerates a missing value', () => {
    installWindow('http://localhost/toolkit?panel=managed-apps');
    expect(readToolkitPanel()).toBe('managed-apps');
    expect(readToolkitPanel('?panel=edge-forwarding')).toBe('edge-forwarding');
    expect(readToolkitPanel('?foo=bar')).toBe('');
  });

  test('writes the panel with replaceState so history is not polluted', () => {
    const { win } = installWindow('http://localhost/toolkit?tab=network#apps');
    writeToolkitPanel('provider-config');
    expect(win.location.search).toBe('?tab=network&panel=provider-config');
    expect(win.location.hash).toBe('#apps');

    writeToolkitPanel('');
    expect(win.location.search).toBe('?tab=network');
  });

  test('notifies subscribers on popstate and unsubscribes cleanly', () => {
    const { win, dispatch } = installWindow('http://localhost/toolkit?panel=managed-apps');
    const seen: string[] = [];
    const unsubscribe = subscribeToolkitPanel((panel) => seen.push(panel));

    win.location.href = 'http://localhost/toolkit?panel=environment';
    dispatch('popstate');
    expect(seen).toEqual(['environment']);

    unsubscribe();
    win.location.href = 'http://localhost/toolkit?panel=terminals';
    dispatch('popstate');
    expect(seen).toEqual(['environment']);
  });
});
