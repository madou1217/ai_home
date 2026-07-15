import type { ServerTransport } from './contract';
import type { BrowserServerTransportOptions } from './browser-adapter';
import type { TauriServerTransportOptions } from './tauri-adapter';

export type ServerTransportRuntime = 'browser' | 'tauri';

export interface ServerTransportFactoryOptions {
  runtime?: ServerTransportRuntime;
  browser?: BrowserServerTransportOptions;
  tauri?: TauriServerTransportOptions;
}

interface TauriRuntimeGlobals {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  __TAURI_IPC__?: unknown;
}

export function isTauriServerRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as unknown as TauriRuntimeGlobals;
  return typeof candidate.__TAURI_IPC__ === 'function'
    || Boolean(candidate.__TAURI_INTERNALS__)
    || Boolean(candidate.__TAURI__);
}

/** Platform adapters are dynamically imported only after runtime detection. */
export async function createServerTransport(
  options: ServerTransportFactoryOptions = {}
): Promise<ServerTransport> {
  const runtime = options.runtime || (isTauriServerRuntime() ? 'tauri' : 'browser');
  if (runtime === 'tauri') {
    const { TauriServerTransport } = await import('./tauri-adapter');
    return new TauriServerTransport(options.tauri);
  }
  const { BrowserServerTransport } = await import('./browser-adapter');
  return new BrowserServerTransport(options.browser);
}
