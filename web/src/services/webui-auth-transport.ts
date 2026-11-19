/*
 * Browser/PWA transport for authenticated WebUI resources.
 * Management Key is read from the same-origin Server Profile and is only sent
 * through Authorization headers, or the dedicated session WebSocket's first
 * frame. Remote Server selection travels in a header, so neither value is
 * copied into URLs or DOM resource attributes.
 */

import {
  getEffectiveServerProfileId,
  getExplicitServerProfileId
} from './server-selection-scope';
import { readSessionWatchTarget, SessionWatchWebSocketSource } from './session-watch-websocket';
import {
  readTerminalMuxTarget,
  TerminalMuxWebSocketSource,
  type TerminalMuxFallbackSource,
} from './terminal-mux-websocket';
import {
  openWatchMultiplexEventSource,
  readMultiplexedWatchPath,
  WATCH_MULTIPLEX_WEBSOCKET_PATH,
  type WatchWebSocketSupportProbeResult,
} from './watch-multiplex-websocket';

const SERVER_PROFILE_STORAGE_KEY = 'aih:control-plane-profiles:v1';
const ACTIVE_PROFILE_STORAGE_KEY = 'aih:active-control-plane-profile:v1';
const ACTIVE_PROFILE_CHANGED_EVENT = 'aih:active-control-plane-profile-changed';
const CONTROL_PLANE_PROFILES_CHANGED_EVENT = 'aih:control-plane-profiles-changed';
const STABLE_STREAM_RESET_MS = 10_000;

export interface WebUiTransportTarget {
  readonly serverId: string;
  readonly isRemote: boolean;
  /** Normalized endpoint origin (local page origin or remote profile origin). */
  readonly targetOrigin: string;
  /** Credential-free routing scope incorporating local/remote, serverId, and origin. */
  readonly scopeKey: string;
}

function normalizeHost(host: string) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '[::1]' || value === '::1' ? '127.0.0.1' : value;
}

function effectivePort(url: URL) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function normalizeEndpointOrigin(raw: string): string {
  try {
    const parsed = new URL(String(raw || ''));
    return `${parsed.protocol}//${normalizeHost(parsed.hostname)}:${effectivePort(parsed)}`;
  } catch (_error) {
    return '';
  }
}

function findStoredProfileEndpoint(serverId: string): string | null {
  if (typeof window === 'undefined' || !serverId) return null;
  try {
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) return null;
    const profile = profiles.find((item) => item && item.id === serverId);
    if (!profile?.endpoint) return null;
    return String(profile.endpoint);
  } catch (_error) {
    return null;
  }
}

function isSameServerEndpoint(left: URL, right: URL) {
  return left.protocol === right.protocol
    && normalizeHost(left.hostname) === normalizeHost(right.hostname)
    && effectivePort(left) === effectivePort(right);
}

export function isSameServerOrigin(left: string | URL, right: string | URL) {
  try {
    const leftUrl = left instanceof URL ? left : new URL(String(left || ''));
    const rightUrl = right instanceof URL ? right : new URL(String(right || ''));
    return isSameServerEndpoint(leftUrl, rightUrl);
  } catch (_error) {
    return false;
  }
}

export function resolveWebUiManagementKey(): string {
  try {
    if (typeof window === 'undefined') return '';
    const origin = new URL(window.location.origin);
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(profiles)) return '';
    for (const profile of profiles) {
      const managementKey = String(profile?.managementKey || '').trim();
      if (!managementKey) continue;
      try {
        const endpoint = new URL(String(profile.endpoint || ''));
        if (isSameServerOrigin(endpoint, origin)) {
          return managementKey;
        }
      } catch (_error) {
        // Ignore invalid profile endpoints.
      }
    }
  } catch (_error) {
    // Treat inaccessible browser storage as an unconfigured client.
  }
  return '';
}

export function resolveActiveServer(): { serverId: string; isRemote: boolean } {
  const explicitProfileId = getExplicitServerProfileId();
  try {
    if (typeof window === 'undefined') return { serverId: '', isRemote: false };
    const activeId = getEffectiveServerProfileId(
      String(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim()
    );
    if (!activeId) return { serverId: '', isRemote: false };
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    const profile = Array.isArray(profiles) ? profiles.find((item) => item && item.id === activeId) : null;
    if (!profile?.endpoint) return { serverId: activeId, isRemote: true };
    const origin = new URL(window.location.origin);
    const target = new URL(String(profile.endpoint));
    const isRemote = !isSameServerOrigin(target, origin);
    return { serverId: activeId, isRemote };
  } catch (_error) {
    return explicitProfileId
      ? { serverId: explicitProfileId, isRemote: true }
      : { serverId: '', isRemote: false };
  }
}

/** 当前 WebUI 所连 server 的对外地址：远端 profile 取其 endpoint，本机取页面 origin。 */
export function resolveActiveServerOrigin(): string {
  if (typeof window === 'undefined') return '';
  const active = resolveActiveServer();
  if (!active.isRemote || !active.serverId) return window.location.origin;
  try {
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    const profile = Array.isArray(profiles) ? profiles.find((item) => item && item.id === active.serverId) : null;
    return profile?.endpoint ? new URL(String(profile.endpoint)).origin : window.location.origin;
  } catch (_error) {
    return window.location.origin;
  }
}

/** Resolve a credential-free, bound transport target for the active server scope. */
export function resolveActiveTransportTarget(): WebUiTransportTarget {
  const active = resolveActiveServer();
  if (!active.isRemote) {
    const localOrigin = typeof window !== 'undefined' ? normalizeEndpointOrigin(window.location.origin) : '';
    return {
      serverId: active.serverId,
      isRemote: false,
      targetOrigin: localOrigin,
      scopeKey: 'local',
    };
  }
  const endpoint = findStoredProfileEndpoint(active.serverId);
  const targetOrigin = endpoint ? normalizeEndpointOrigin(endpoint) : '';
  return {
    serverId: active.serverId,
    isRemote: true,
    targetOrigin,
    scopeKey: `remote:${encodeURIComponent(active.serverId)}@${encodeURIComponent(targetOrigin)}`,
  };
}

/** Verify whether a previously captured transport target still matches stored profile routing. */
export function isTransportTargetStillValid(target: WebUiTransportTarget): boolean {
  if (!target.isRemote) {
    return typeof window === 'undefined' || normalizeEndpointOrigin(window.location.origin) === target.targetOrigin;
  }
  const endpoint = findStoredProfileEndpoint(target.serverId);
  if (!target.targetOrigin) return !endpoint;
  return endpoint !== null && normalizeEndpointOrigin(endpoint) === target.targetOrigin;
}

/** Listen for same-tab and cross-tab control-plane profile or active-server mutations. */
export function subscribeTransportTargetChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onProfileChanged = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null
      || event.key === ACTIVE_PROFILE_STORAGE_KEY
      || event.key === SERVER_PROFILE_STORAGE_KEY
    ) {
      listener();
    }
  };
  window.addEventListener(ACTIVE_PROFILE_CHANGED_EVENT, onProfileChanged);
  window.addEventListener(CONTROL_PLANE_PROFILES_CHANGED_EVENT, onProfileChanged);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACTIVE_PROFILE_CHANGED_EVENT, onProfileChanged);
    window.removeEventListener(CONTROL_PLANE_PROFILES_CHANGED_EVENT, onProfileChanged);
    window.removeEventListener('storage', onStorage);
  };
}

export function buildAuthorizedWebUiHeaders(
  input?: HeadersInit,
  target?: Pick<WebUiTransportTarget, 'serverId' | 'isRemote'>,
) {
  const headers = new Headers(input || {});
  const managementKey = resolveWebUiManagementKey();
  const resolved = target ?? resolveActiveServer();
  if (managementKey) headers.set('authorization', `Bearer ${managementKey}`);
  if (resolved.isRemote && resolved.serverId) headers.set('x-aih-server-id', resolved.serverId);
  else headers.delete('x-aih-server-id');
  return headers;
}

export async function fetchAuthorizedWebUiResource(
  input: RequestInfo | URL,
  init: RequestInit = {},
  target?: Pick<WebUiTransportTarget, 'serverId' | 'isRemote'>,
) {
  return fetch(input, {
    ...init,
    headers: buildAuthorizedWebUiHeaders(init.headers, target),
    credentials: init.credentials || 'same-origin'
  });
}

export async function fetchAuthorizedWebUiBlob(
  input: RequestInfo | URL,
  init: RequestInit = {}
) {
  const response = await fetchAuthorizedWebUiResource(input, init);
  if (!response.ok) throw new Error(`authorized_media_http_${response.status}`);
  return response.blob();
}

function findSseBoundary(buffer: string) {
  const unix = buffer.indexOf('\n\n');
  const windows = buffer.indexOf('\r\n\r\n');
  if (unix < 0 && windows < 0) return null;
  if (unix < 0) return { index: windows, length: 4 };
  if (windows < 0) return { index: unix, length: 2 };
  return unix < windows ? { index: unix, length: 2 } : { index: windows, length: 4 };
}

function parseSseMessage(frame: string) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  return data ? new MessageEvent('message', { data }) : null;
}

class AuthorizedWebUiEventSource extends EventTarget {
  readonly url: string;
  readonly withCredentials = false;
  readonly CONNECTING = EventSource.CONNECTING;
  readonly OPEN = EventSource.OPEN;
  readonly CLOSED = EventSource.CLOSED;
  readyState: number = EventSource.CONNECTING;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  private abortController: AbortController | null = null;
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private readPaused = false;
  private resumeReader: (() => void) | null = null;
  private lastActivityAt = Date.now();
  private watchdogTimer: number | null = null;
  private readonly silenceTimeoutMs: number;
  private readonly boundTarget?: WebUiTransportTarget;

  private cancelActiveTransport() {
    const reader = this.activeReader;
    this.activeReader = null;
    if (reader) void reader.cancel().catch(() => {});
    this.abortController?.abort();
    this.abortController = null;
  }

  private handlePageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      this.close();
      return;
    }
    this.cancelActiveTransport();
  };

  private checkConnection = () => {
    if (!this.closed && !this.readPaused && this.silenceTimeoutMs > 0
      && Date.now() - this.lastActivityAt >= this.silenceTimeoutMs) {
      this.cancelActiveTransport();
    }
  };

  private resumeConnection = () => {
    if (this.closed) return;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      void this.connect();
      return;
    }
    if (this.silenceTimeoutMs > 0 && !this.readPaused) this.cancelActiveTransport();
  };

  setReadPaused(paused: boolean) {
    this.readPaused = paused;
    if (!paused) {
      // Rendering backpressure is not a dead connection. Start a fresh grace
      // period when the consumer resumes reading buffered heartbeats/output.
      this.lastActivityAt = Date.now();
      this.resumeReader?.();
      this.resumeReader = null;
    }
  }

  private waitForReader() {
    return this.readPaused && !this.closed ? new Promise<void>((resolve) => { this.resumeReader = resolve; }) : Promise.resolve();
  }

  constructor(url: string, silenceTimeoutMs = 0, boundTarget?: WebUiTransportTarget) {
    super();
    this.url = url;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.boundTarget = boundTarget;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.resumeConnection);
      window.addEventListener('pagehide', this.handlePageHide);
    }
    if (silenceTimeoutMs > 0 && typeof window !== 'undefined') {
      this.watchdogTimer = window.setInterval(this.checkConnection, Math.min(5000, silenceTimeoutMs));
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.checkConnection);
      }
    }
    queueMicrotask(() => this.connect());
  }

  close() {
    this.closed = true;
    this.setReadPaused(false);
    this.readyState = EventSource.CLOSED;
    this.cancelActiveTransport();
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.checkConnection);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.resumeConnection);
      window.removeEventListener('pagehide', this.handlePageHide);
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emitOpen() {
    const event = new Event('open');
    this.onopen?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private emitMessage(event: MessageEvent) {
    this.onmessage?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private emitError() {
    const event = new Event('error');
    this.onerror?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null || typeof window === 'undefined') return;
    this.readyState = EventSource.CONNECTING;
    const baseDelayMs = Math.min(15_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 4));
    const jitterMs = this.reconnectAttempt > 0 ? Math.floor(Math.random() * 250) : 0;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, baseDelayMs + jitterMs);
  }

  private async connect() {
    if (this.closed) return;
    if (this.boundTarget && !isTransportTargetStillValid(this.boundTarget)) {
      this.close();
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.lastActivityAt = Date.now();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let openedAt = 0;
    let stableResetTimer: number | null = null;
    try {
      const response = await fetchAuthorizedWebUiResource(this.url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal
      }, this.boundTarget);
      if (this.closed) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`webui_event_stream_http_${response.status}`);
      }
      openedAt = Date.now();
      this.lastActivityAt = openedAt;
      this.readyState = EventSource.OPEN;
      // Reset reconnect backoff only after the stream stays stably open for
      // STABLE_STREAM_RESET_MS so HTTP 200 + immediate EOF/read failure still
      // enters exponential backoff (2s/4s/8s/15s) instead of looping at 1s.
      if (typeof window !== 'undefined') {
        stableResetTimer = window.setTimeout(() => {
          stableResetTimer = null;
          if (!this.closed && this.abortController === controller) {
            this.reconnectAttempt = 0;
          }
        }, STABLE_STREAM_RESET_MS);
      }
      this.emitOpen();

      reader = response.body.getReader();
      this.activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed) {
        if (this.readPaused) await this.waitForReader();
        if (this.closed) break;
        const { done, value } = await reader.read();
        if (done) break;
        this.lastActivityAt = Date.now(); // SSE comments are heartbeats too.
        buffer += decoder.decode(value, { stream: true });
        let boundary = findSseBoundary(buffer);
        while (boundary) {
          const event = parseSseMessage(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary.length);
          if (event) this.emitMessage(event);
          if (this.readPaused) await this.waitForReader();
          if (this.closed) return;
          boundary = findSseBoundary(buffer);
        }
      }
      const tail = decoder.decode();
      if (tail) buffer += tail;
      const finalEvent = parseSseMessage(buffer);
      if (finalEvent) this.emitMessage(finalEvent);
      if (!this.closed) this.emitError();
    } catch (_error) {
      if (!this.closed) this.emitError();
    } finally {
      if (stableResetTimer !== null && typeof window !== 'undefined') {
        window.clearTimeout(stableResetTimer);
        stableResetTimer = null;
      }
      if (openedAt > 0 && Date.now() - openedAt >= STABLE_STREAM_RESET_MS) {
        this.reconnectAttempt = 0;
      }
      if (reader) {
        if (this.activeReader === reader) this.activeReader = null;
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch (_error) { /* ignore */ }
      }
      controller.abort();
      if (this.abortController === controller) this.abortController = null;
      this.scheduleReconnect();
    }
  }
}

async function probeWatchWebSocketSupport(
  signal: AbortSignal,
  target: WebUiTransportTarget,
): Promise<WatchWebSocketSupportProbeResult> {
  if (target.isRemote || !isTransportTargetStillValid(target)) {
    return 'policy';
  }
  try {
    const response = await fetchAuthorizedWebUiResource(WATCH_MULTIPLEX_WEBSOCKET_PATH, {
      method: 'GET',
      cache: 'no-store',
      signal,
    }, target);
    void response.body?.cancel().catch(() => {});
    if (response.status === 426) return 'supported';
    if (response.status === 404 || response.status === 501) return 'unsupported';
    if (response.status === 401 || response.status === 403) return 'policy';
    return 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

export function guardedWebUiEventSource(
  path: string,
  options: { silenceTimeoutMs?: number; target?: WebUiTransportTarget } = {},
): EventSource {
  const effectiveTarget = options.target ?? resolveActiveTransportTarget();
  const target = readSessionWatchTarget(path);
  if (target && typeof window !== 'undefined' && typeof WebSocket !== 'undefined'
    && effectiveTarget.isRemote === false) {
    return new SessionWatchWebSocketSource({
      origin: window.location.origin,
      target,
      readManagementKey: resolveWebUiManagementKey
    }) as unknown as EventSource;
  }
  const muxTarget = readTerminalMuxTarget(path);
  if (muxTarget && typeof window !== 'undefined' && typeof WebSocket !== 'undefined'
    && effectiveTarget.isRemote === false) {
    return new TerminalMuxWebSocketSource({
      origin: window.location.origin,
      muxId: muxTarget.muxId,
      readManagementKey: resolveWebUiManagementKey,
      silenceTimeoutMs: options.silenceTimeoutMs,
      createSseFallback: () => new AuthorizedWebUiEventSource(
        path,
        options.silenceTimeoutMs,
        effectiveTarget,
      ) as unknown as TerminalMuxFallbackSource,
    }) as unknown as EventSource;
  }
  const watchPath = readMultiplexedWatchPath(path);
  if (watchPath && typeof window !== 'undefined' && typeof WebSocket !== 'undefined'
    && effectiveTarget.isRemote === false) {
    return openWatchMultiplexEventSource({
      origin: window.location.origin,
      path: watchPath,
      target: effectiveTarget,
      readManagementKey: resolveWebUiManagementKey,
      isTargetStillValid: () => isTransportTargetStillValid(effectiveTarget),
      subscribeTargetChange: subscribeTransportTargetChange,
      probeWebSocketSupport: (signal) => probeWatchWebSocketSupport(signal, effectiveTarget),
      createSseFallback: () => new AuthorizedWebUiEventSource(
        path,
        options.silenceTimeoutMs,
        effectiveTarget,
      ) as unknown as EventSource,
    });
  }
  return new AuthorizedWebUiEventSource(path, options.silenceTimeoutMs, effectiveTarget) as unknown as EventSource;
}
