import type {
  ServerBlobResponse,
  ServerJsonResponse,
  ServerRequest,
  ServerResponseHeaders,
  ServerSseHandlers,
  ServerStreamHandle,
  ServerTransport
} from './contract';
import { asServerTransportError, ServerTransportError } from './errors';
import {
  assertRequestNotAborted,
  selectSafeRequestHeaders,
  validateRequest
} from './request-policy';
import { createServerSseParser } from './sse-parser';

export interface BrowserServerProfile {
  endpoint: string;
  managementKey?: string;
}

export type BrowserServerProfileResolver = (
  profileId: string
) => BrowserServerProfile | Promise<BrowserServerProfile>;

export interface BrowserServerTransportOptions {
  resolveProfile?: BrowserServerProfileResolver;
  fetchImpl?: typeof fetch;
  createRequestId?: () => string;
}

interface AbortContext {
  controller: AbortController;
  cleanup: () => void;
  didTimeout: () => boolean;
}

let requestSequence = 0;

function defaultRequestId() {
  requestSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId || `browser-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function defaultProfileResolver(): BrowserServerProfile {
  if (typeof window === 'undefined' || !window.location?.origin) {
    throw new ServerTransportError('missing_browser_server_endpoint');
  }
  return { endpoint: window.location.origin };
}

function normalizeBrowserEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(String(value || ''));
  } catch (error) {
    throw new ServerTransportError('invalid_browser_server_endpoint', { cause: error });
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new ServerTransportError('invalid_browser_server_endpoint');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ServerTransportError('invalid_browser_server_endpoint');
  }
  return endpoint;
}

function buildRequestUrl(endpointValue: string, path: string) {
  const endpoint = normalizeBrowserEndpoint(endpointValue);
  const requestPath = new URL(path, 'https://aih-server.invalid');
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = `${basePath}${requestPath.pathname}`;
  endpoint.search = requestPath.search;
  return endpoint.toString();
}

function createAbortContext(signal?: AbortSignal, timeoutMs?: number): AbortContext {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();

  if (timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    controller,
    cleanup() {
      signal?.removeEventListener('abort', onAbort);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
    didTimeout: () => timedOut
  };
}

function responseHeaders(response: Response): ServerResponseHeaders {
  const contentType = response.headers.get('content-type') || undefined;
  const contentDisposition = response.headers.get('content-disposition') || undefined;
  return {
    ...(contentType ? { contentType } : {}),
    ...(contentDisposition ? { contentDisposition } : {})
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ServerTransportError('invalid_server_json_response', {
      status: response.status,
      cause: error
    });
  }
}

function assertSuccessfulResponse(response: Response) {
  if (!response.ok) {
    throw new ServerTransportError(`server_http_${response.status}`, {
      status: response.status
    });
  }
}

function serializeBody(body: unknown) {
  if (body === undefined) return undefined;
  try {
    return JSON.stringify(body);
  } catch (error) {
    throw new ServerTransportError('invalid_server_json_body', { cause: error });
  }
}

export class BrowserServerTransport implements ServerTransport {
  private readonly resolveProfile: BrowserServerProfileResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly createRequestId: () => string;

  constructor(options: BrowserServerTransportOptions = {}) {
    this.resolveProfile = options.resolveProfile || defaultProfileResolver;
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.createRequestId = options.createRequestId || defaultRequestId;
  }

  async requestJson<TData, TBody>(
    request: ServerRequest<TBody>
  ): Promise<ServerJsonResponse<TData>> {
    const response = await this.fetchOnce(request, 'application/json');
    try {
      const data = await readJsonBody(response.value);
      return {
        status: response.value.status,
        headers: responseHeaders(response.value),
        data: data as TData
      };
    } finally {
      response.cleanup();
    }
  }

  async requestBlob<TBody>(request: ServerRequest<TBody>): Promise<ServerBlobResponse> {
    const response = await this.fetchOnce(request, '*/*');
    try {
      assertSuccessfulResponse(response.value);
      const data = await response.value.blob();
      return {
        headers: responseHeaders(response.value),
        data,
        size: data.size
      };
    } finally {
      response.cleanup();
    }
  }

  async openSse<TBody>(
    request: ServerRequest<TBody>,
    handlers: ServerSseHandlers
  ): Promise<ServerStreamHandle> {
    const response = await this.fetchOnce(request, 'text/event-stream');
    try {
      assertSuccessfulResponse(response.value);
      if (!response.value.body) {
        throw new ServerTransportError('missing_server_stream_body', {
          status: response.value.status
        });
      }
      const contentType = response.value.headers.get('content-type')?.toLowerCase() || '';
      if (!contentType.startsWith('text/event-stream')) {
        throw new ServerTransportError('invalid_server_stream_response', {
          status: response.value.status
        });
      }
    } catch (error) {
      response.cleanup();
      throw error;
    }

    const requestId = this.createRequestId();
    const parser = createServerSseParser(handlers.onEvent);
    const reader = response.value.body.getReader();
    let closed = false;
    let cancelPromise: Promise<void> | null = null;

    const close = (reason: 'cancelled' | 'completed' | 'error') => {
      if (closed) return;
      closed = true;
      response.cleanup();
      try {
        handlers.onClose?.(reason);
      } catch (_error) {
        // Consumer cleanup must not change the transport result.
      }
    };

    try {
      handlers.onOpen?.({ requestId, status: response.value.status });
    } catch (error) {
      parser.cancel();
      await reader.cancel();
      close('error');
      throw asServerTransportError(error, 'server_stream_handler_failed');
    }

    const done = (async () => {
      try {
        while (!closed) {
          const next = await reader.read();
          if (next.done) break;
          parser.push(next.value);
        }
        if (!closed) {
          parser.finish();
          close('completed');
        }
      } catch (error) {
        if (closed || response.abortContext.controller.signal.aborted) {
          parser.cancel();
          close('cancelled');
          return;
        }
        const streamError = asServerTransportError(error, 'server_stream_failed');
        parser.cancel();
        try {
          handlers.onError?.(streamError);
        } catch (_handlerError) {
          // Preserve the transport error.
        }
        close('error');
        throw streamError;
      }
    })();

    return {
      requestId,
      status: response.value.status,
      done,
      cancel() {
        if (cancelPromise) return cancelPromise;
        cancelPromise = (async () => {
          if (closed) return;
          parser.cancel();
          close('cancelled');
          await reader.cancel();
        })();
        return cancelPromise;
      }
    };
  }

  private async fetchOnce<TBody>(
    request: ServerRequest<TBody>,
    defaultAccept: string
  ): Promise<{
    value: Response;
    abortContext: AbortContext;
    cleanup: () => void;
  }> {
    assertRequestNotAborted(request.signal);
    const normalized = validateRequest(request);
    const headers = selectSafeRequestHeaders(request.headers, {
      accept: defaultAccept,
      ...(request.body !== undefined ? { contentType: 'application/json' } : {})
    }, request.body !== undefined);
    const profile = await this.resolveProfile(normalized.profileId);
    const managementKey = String(profile?.managementKey || '').trim();
    if (managementKey.length > 4096 || /[\r\n\0]/.test(managementKey)) {
      throw new ServerTransportError('invalid_browser_management_key');
    }

    const requestHeaders = new Headers();
    if (headers.accept) requestHeaders.set('accept', headers.accept);
    if (headers.contentType) requestHeaders.set('content-type', headers.contentType);
    if (managementKey) requestHeaders.set('authorization', `Bearer ${managementKey}`);

    const abortContext = createAbortContext(request.signal, normalized.timeoutMs);
    try {
      const value = await this.fetchImpl(buildRequestUrl(profile.endpoint, normalized.path), {
        method: normalized.method,
        headers: requestHeaders,
        body: serializeBody(request.body),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: abortContext.controller.signal
      });
      return {
        value,
        abortContext,
        cleanup: abortContext.cleanup
      };
    } catch (error) {
      abortContext.cleanup();
      if (abortContext.controller.signal.aborted) {
        throw new ServerTransportError(
          abortContext.didTimeout() ? 'server_request_timeout' : 'server_request_cancelled',
          { cause: error }
        );
      }
      throw asServerTransportError(error, 'server_network_error');
    }
  }
}
