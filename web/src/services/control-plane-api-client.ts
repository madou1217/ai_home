const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 10000;

interface FetchLikeOptions {
  method?: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  signal?: AbortSignal;
  body?: BodyInit | null;
}

type FetchLike = (input: string, init?: FetchLikeOptions) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type ControlPlaneEventStreamFetch = (input: string, init?: FetchLikeOptions) => Promise<{
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
}>;

export interface ControlPlaneApiClientOptions {
  endpoint: string;
  managementKey?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface ControlPlaneJsonRequestOptions {
  managementKey?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  requireManagementKey?: boolean;
  httpErrorPrefix?: string;
}

export interface ControlPlaneEventStreamRequestOptions {
  managementKey?: string;
  requireManagementKey?: boolean;
}

export interface ControlPlaneEventStreamRequest {
  url: string;
  headers: Record<string, string>;
}

export interface ControlPlaneEventStreamConsumeOptions {
  fetchImpl?: ControlPlaneEventStreamFetch;
  signal?: AbortSignal;
  httpErrorPrefix?: string;
}

export interface ControlPlaneEventStreamHandlers {
  onFrame: (frame: unknown) => void;
}

function normalizeText(value: unknown, maxLength = 2048) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEndpointPath(pathname: string) {
  const value = String(pathname || '').replace(/\/+$/, '');
  if (!value || value === '/ui') return '';
  if (value.endsWith('/ui')) return value.slice(0, -3).replace(/\/+$/, '');
  return value;
}

export function normalizeControlPlaneEndpoint(value: string): string {
  const raw = normalizeText(value).replace(/\/+$/, '');
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = normalizeEndpointPath(parsed.pathname);
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function normalizeControlPlanePath(path: string): { pathname: string; search: string } | null {
  const raw = normalizeText(path);
  if (!raw || !raw.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  try {
    const parsed = new URL(raw, 'http://aih-control-plane.local');
    return {
      pathname: parsed.pathname,
      search: parsed.search
    };
  } catch (_error) {
    return null;
  }
}

export function buildControlPlaneHttpUrl(endpoint: string, path: string): string {
  const normalizedEndpoint = normalizeControlPlaneEndpoint(endpoint);
  const normalizedPath = normalizeControlPlanePath(path);
  if (!normalizedEndpoint || !normalizedPath) return '';
  const parsed = new URL(normalizedEndpoint);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}${normalizedPath.pathname}`;
  parsed.search = normalizedPath.search;
  parsed.hash = '';
  return parsed.toString();
}

export function buildControlPlaneWebSocketUrl(endpoint: string, path: string): string {
  const httpUrl = buildControlPlaneHttpUrl(endpoint, path);
  if (!httpUrl) return '';
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.toString();
}

function resolveFetch(options: { fetchImpl?: FetchLike }) {
  const fetcher = options.fetchImpl || globalThis.fetch;
  if (!fetcher) {
    throw new Error('missing_fetch_impl');
  }
  return fetcher as FetchLike;
}

function resolveEventStreamFetch(options: { fetchImpl?: ControlPlaneEventStreamFetch }) {
  const fetcher = options.fetchImpl || globalThis.fetch;
  if (!fetcher) {
    throw new Error('missing_fetch_impl');
  }
  return fetcher as ControlPlaneEventStreamFetch;
}

function buildJsonHeaders(managementKey: string, hasBody: boolean) {
  const headers: Record<string, string> = {
    accept: 'application/json'
  };
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  if (managementKey) {
    headers.authorization = `Bearer ${managementKey}`;
  }
  return headers;
}

function buildEventStreamHeaders(managementKey: string) {
  const headers: Record<string, string> = {
    accept: 'text/event-stream'
  };
  if (managementKey) {
    headers.authorization = `Bearer ${managementKey}`;
  }
  return headers;
}

function findEventFrameBoundary(buffer: string) {
  const unixIndex = buffer.indexOf('\n\n');
  const windowsIndex = buffer.indexOf('\r\n\r\n');
  if (unixIndex < 0 && windowsIndex < 0) return null;
  if (unixIndex < 0) return { index: windowsIndex, length: 4 };
  if (windowsIndex < 0) return { index: unixIndex, length: 2 };
  return unixIndex < windowsIndex
    ? { index: unixIndex, length: 2 }
    : { index: windowsIndex, length: 4 };
}

function parseEventFrameData(frame: string) {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return dataLines.length > 0 ? dataLines.join('\n').trim() : '';
}

export function createControlPlaneEventStreamParser(onFrame: (frame: unknown) => void) {
  let buffer = '';

  const dispatch = (frame: string) => {
    const data = parseEventFrameData(frame);
    if (!data) return;
    onFrame(JSON.parse(data));
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let boundary = findEventFrameBoundary(buffer);
      while (boundary) {
        dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = findEventFrameBoundary(buffer);
      }
    },
    flush() {
      if (!buffer.trim()) {
        buffer = '';
        return;
      }
      dispatch(buffer);
      buffer = '';
    }
  };
}

export async function consumeControlPlaneEventStream(
  request: ControlPlaneEventStreamRequest,
  handlers: ControlPlaneEventStreamHandlers,
  options: ControlPlaneEventStreamConsumeOptions = {}
) {
  const response = await resolveEventStreamFetch(options)(request.url, {
    method: 'GET',
    headers: request.headers,
    credentials: 'omit',
    signal: options.signal
  });
  if (!response.ok) {
    const prefix = normalizeText(options.httpErrorPrefix, 96) || 'control_plane_event_stream_http';
    throw new Error(`${prefix}_${response.status}`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('missing_control_plane_event_stream_body');
  }

  const parser = createControlPlaneEventStreamParser(handlers.onFrame);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail) parser.push(tail);
  parser.flush();
}

export class ControlPlaneApiClient {
  readonly endpoint: string;
  private readonly managementKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: FetchLike;

  constructor(options: ControlPlaneApiClientOptions) {
    this.endpoint = normalizeControlPlaneEndpoint(options.endpoint);
    this.managementKey = normalizeText(options.managementKey, 4096);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_CONTROL_PLANE_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl;
    if (!this.endpoint) {
      throw new Error('invalid_control_plane_endpoint');
    }
  }

  buildHttpUrl(path: string) {
    const url = buildControlPlaneHttpUrl(this.endpoint, path);
    if (!url) {
      throw new Error('invalid_control_plane_request_path');
    }
    return url;
  }

  buildEventSourceUrl(path: string) {
    return this.buildHttpUrl(path);
  }

  buildEventStreamRequest(path: string, options: ControlPlaneEventStreamRequestOptions = {}): ControlPlaneEventStreamRequest {
    const managementKey = normalizeText(
      options.managementKey === undefined ? this.managementKey : options.managementKey,
      4096
    );
    if (options.requireManagementKey && !managementKey) {
      throw new Error('missing_management_key');
    }
    return {
      url: this.buildEventSourceUrl(path),
      headers: buildEventStreamHeaders(managementKey)
    };
  }

  buildWebSocketUrl(path: string) {
    const url = buildControlPlaneWebSocketUrl(this.endpoint, path);
    if (!url) {
      throw new Error('invalid_control_plane_request_path');
    }
    return url;
  }

  getJson(path: string, options: ControlPlaneJsonRequestOptions = {}) {
    return this.requestJson('GET', path, undefined, options);
  }

  postJson(path: string, body: unknown, options: ControlPlaneJsonRequestOptions = {}) {
    return this.requestJson('POST', path, body, options);
  }

  private async requestJson(method: string, path: string, body: unknown, options: ControlPlaneJsonRequestOptions) {
    const managementKey = normalizeText(
      options.managementKey === undefined ? this.managementKey : options.managementKey,
      4096
    );
    if (options.requireManagementKey && !managementKey) {
      throw new Error('missing_management_key');
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort('control_plane_request_timeout'),
      Math.max(1000, Number(options.timeoutMs) || this.timeoutMs)
    );
    try {
      const response = await resolveFetch({ fetchImpl: options.fetchImpl || this.fetchImpl })(this.buildHttpUrl(path), {
        method,
        headers: buildJsonHeaders(managementKey, body !== undefined),
        credentials: 'omit',
        signal: controller.signal,
        body: body === undefined ? null : JSON.stringify(body)
      });
      if (!response.ok) {
        const prefix = normalizeText(options.httpErrorPrefix, 96) || 'control_plane_http';
        throw new Error(`${prefix}_${response.status}`);
      }
      return response.json();
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}

export function createControlPlaneApiClient(options: ControlPlaneApiClientOptions) {
  return new ControlPlaneApiClient(options);
}
