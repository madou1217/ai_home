/*
 * Browser/PWA transport for authenticated WebUI resources.
 * Management Key is read from the same-origin Server Profile and is only sent
 * through Authorization headers. Remote Server selection travels in a header
 * as well, so neither value is copied into URLs or DOM resource attributes.
 */

import { isNativeDesktopRuntime } from './native-server-profile-repository';
import {
  isNativeServerTransportAvailable,
  openNativeServerSse,
  requestNativeServerBlob,
  requestNativeServerJson
} from './native-server-transport';
import type { ServerStreamHandle } from './server-transport';

const SERVER_PROFILE_STORAGE_KEY = 'aih:control-plane-profiles:v1';
const ACTIVE_PROFILE_STORAGE_KEY = 'aih:active-control-plane-profile:v1';

function normalizeHost(host: string) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '[::1]' || value === '::1' ? '127.0.0.1' : value;
}

function effectivePort(url: URL) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
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
    if (typeof window === 'undefined' || isNativeDesktopRuntime()) return '';
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
  try {
    if (typeof window === 'undefined') return { serverId: '', isRemote: false };
    const activeId = String(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim();
    if (!activeId) return { serverId: '', isRemote: false };
    const raw = window.localStorage.getItem(SERVER_PROFILE_STORAGE_KEY);
    const profiles = raw ? JSON.parse(raw) : [];
    const profile = Array.isArray(profiles) ? profiles.find((item) => item && item.id === activeId) : null;
    if (!profile?.endpoint) return { serverId: '', isRemote: false };
    const origin = new URL(window.location.origin);
    const target = new URL(String(profile.endpoint));
    const isRemote = !isSameServerOrigin(target, origin);
    return { serverId: activeId, isRemote };
  } catch (_error) {
    return { serverId: '', isRemote: false };
  }
}

export function buildAuthorizedWebUiHeaders(input?: HeadersInit) {
  const headers = new Headers(input || {});
  const managementKey = resolveWebUiManagementKey();
  const active = resolveActiveServer();
  if (managementKey) headers.set('authorization', `Bearer ${managementKey}`);
  if (active.isRemote && active.serverId) headers.set('x-aih-server-id', active.serverId);
  return headers;
}

function nativeResourcePath(input: RequestInfo | URL) {
  const raw = input instanceof Request ? input.url : String(input);
  const parsed = new URL(raw, 'https://aih-native.invalid');
  return `${parsed.pathname}${parsed.search}`;
}

function nativeActiveProfileId() {
  if (typeof window === 'undefined') return '';
  return String(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim();
}

function parseNativeRequestBody(body: BodyInit | null | undefined) {
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body !== 'string') throw new Error('native_request_body_must_be_json');
  return JSON.parse(body);
}

export async function fetchAuthorizedWebUiResource(input: RequestInfo | URL, init: RequestInit = {}) {
  if (isNativeServerTransportAvailable()) {
    const profileId = nativeActiveProfileId();
    if (!profileId) throw new Error('missing_active_server_profile');
    try {
      const response = await requestNativeServerJson({
        profileId,
        method: String(init.method || 'GET').toUpperCase() as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
        path: nativeResourcePath(input),
        body: parseNativeRequestBody(init.body),
        accept: new Headers(init.headers || {}).get('accept') || 'application/json',
        contentType: new Headers(init.headers || {}).get('content-type') || undefined,
        signal: init.signal || undefined
      });
      return new Response(JSON.stringify(response.data), {
        status: response.status,
        headers: {
          'content-type': response.headers.contentType || 'application/json'
        }
      });
    } catch (error) {
      const source = error as { code?: unknown; status?: unknown };
      const status = Number(source?.status);
      if (Number.isInteger(status) && status >= 400 && status <= 599) {
        return new Response(JSON.stringify({ error: String(source?.code || 'native_server_error') }), {
          status,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw error;
    }
  }
  return fetch(input, {
    ...init,
    headers: buildAuthorizedWebUiHeaders(init.headers),
    credentials: init.credentials || 'same-origin'
  });
}

export async function fetchAuthorizedWebUiBlob(
  input: RequestInfo | URL,
  init: RequestInit = {}
) {
  if (!isNativeServerTransportAvailable()) {
    const response = await fetchAuthorizedWebUiResource(input, init);
    if (!response.ok) throw new Error(`authorized_media_http_${response.status}`);
    return response.blob();
  }
  const profileId = nativeActiveProfileId();
  if (!profileId) throw new Error('missing_active_server_profile');
  const result = await requestNativeServerBlob({
    profileId,
    method: String(init.method || 'GET').toUpperCase() as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
    path: nativeResourcePath(input),
    body: parseNativeRequestBody(init.body),
    accept: new Headers(init.headers || {}).get('accept') || '*/*',
    contentType: new Headers(init.headers || {}).get('content-type') || undefined,
    signal: init.signal || undefined
  });
  return result.data;
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
  private reconnectTimer: number | null = null;
  private closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => this.connect());
  }

  close() {
    this.closed = true;
    this.readyState = EventSource.CLOSED;
    this.abortController?.abort();
    this.abortController = null;
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
    if (this.closed || this.reconnectTimer !== null) return;
    this.readyState = EventSource.CONNECTING;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private async connect() {
    if (this.closed) return;
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const response = await fetchAuthorizedWebUiResource(this.url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`webui_event_stream_http_${response.status}`);
      this.readyState = EventSource.OPEN;
      this.emitOpen();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = findSseBoundary(buffer);
        while (boundary) {
          const event = parseSseMessage(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary.length);
          if (event) this.emitMessage(event);
          boundary = findSseBoundary(buffer);
        }
      }
      const tail = decoder.decode();
      if (tail) buffer += tail;
      const finalEvent = parseSseMessage(buffer);
      if (finalEvent) this.emitMessage(finalEvent);
      if (!this.closed) this.emitError();
    } catch (_error) {
      if (!this.closed && !controller.signal.aborted) this.emitError();
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.scheduleReconnect();
    }
  }
}

class NativeAuthorizedWebUiEventSource extends EventTarget {
  readonly url: string;
  readonly withCredentials = false;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState: number = 0;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  private handle: ServerStreamHandle | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => this.connect());
  }

  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const handle = this.handle;
    this.handle = null;
    if (handle) void handle.cancel();
  }

  private emitOpen() {
    const event = new Event('open');
    this.onopen?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private emitMessage(data: string) {
    const event = new MessageEvent('message', { data });
    this.onmessage?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private emitError() {
    const event = new Event('error');
    this.onerror?.call(this as unknown as EventSource, event);
    this.dispatchEvent(event);
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null) return;
    this.readyState = this.CONNECTING;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private async connect() {
    if (this.closed) return;
    const profileId = String(window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim();
    if (!profileId) {
      this.emitError();
      this.scheduleReconnect();
      return;
    }
    try {
      const handle = await openNativeServerSse({
        profileId,
        method: 'GET',
        path: this.url,
        accept: 'text/event-stream'
      }, {
        onOpen: () => {
          if (this.closed) return;
          this.readyState = this.OPEN;
          this.emitOpen();
        },
        onEvent: (event) => this.emitMessage(event.data)
      });
      if (this.closed) {
        await handle.cancel();
        return;
      }
      this.handle = handle;
      await handle.done;
      if (this.handle === handle) this.handle = null;
      if (!this.closed) this.emitError();
    } catch (_error) {
      if (!this.closed) this.emitError();
    } finally {
      this.scheduleReconnect();
    }
  }
}

export function guardedWebUiEventSource(path: string): EventSource {
  return (
    isNativeServerTransportAvailable()
      ? new NativeAuthorizedWebUiEventSource(path)
      : new AuthorizedWebUiEventSource(path)
  ) as unknown as EventSource;
}
