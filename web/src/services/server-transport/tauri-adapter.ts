import { listen } from '@tauri-apps/api/event';
import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import type {
  ServerBlobResponse,
  ServerJsonResponse,
  ServerRequest,
  ServerResponseHeaders,
  ServerSseHandlers,
  ServerStreamHandle,
  ServerTransport
} from './contract';
import {
  asServerTransportError,
  fromNativeCommandError,
  ServerTransportError
} from './errors';
import {
  assertNativeBodyIsCredentialFree,
  assertRequestNotAborted,
  selectSafeRequestHeaders,
  validateRequest
} from './request-policy';
import { createServerSseParser } from './sse-parser';
import {
  TAURI_SERVER_COMMANDS,
  TAURI_SERVER_STREAM_EVENT
} from './tauri-contract';
import type {
  TauriServerBlobHandle,
  TauriServerBlobReleaseResponse,
  TauriServerJsonResponse,
  TauriServerRequestInput,
  TauriServerStreamCancelResponse,
  TauriServerStreamEvent,
  TauriServerStreamOpenResponse
} from './tauri-contract';

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void
) => Promise<() => void>;

export interface TauriServerTransportOptions {
  invokeImpl?: InvokeFn;
  listenImpl?: ListenFn;
  convertFileSrcImpl?: (path: string, protocol?: string) => string;
  fetchImpl?: typeof fetch;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error)
  };
}

function nativeErrorCode(error: unknown, fallback: string) {
  const candidate = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && 'code' in error
      ? String(error.code || '')
      : '';
  return /^[a-z][a-z0-9_.:-]{0,95}$/i.test(candidate) ? candidate : fallback;
}

function assertSuccessStatus(status: number) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new ServerTransportError(
      Number.isInteger(status) ? `server_http_${status}` : 'invalid_native_http_status',
      { status: Number.isInteger(status) ? status : undefined }
    );
  }
}

function normalizeResponseHeaders(value: unknown): ServerResponseHeaders {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const contentType = String(source.contentType || '').trim();
  const contentDisposition = String(source.contentDisposition || '').trim();
  if (
    contentType.length > 512
    || contentDisposition.length > 4096
    || /[\r\n\0]/.test(contentType)
    || /[\r\n\0]/.test(contentDisposition)
  ) {
    throw new ServerTransportError('invalid_native_response_header');
  }
  return {
    ...(contentType ? { contentType } : {}),
    ...(contentDisposition ? { contentDisposition } : {})
  };
}

function decodeBase64Chunk(value: string): Uint8Array {
  if (!value || value.length > 16 * 1024 * 1024 || !/^[a-z\d+/]*={0,2}$/i.test(value)) {
    throw new ServerTransportError('invalid_native_stream_chunk');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new ServerTransportError('invalid_native_stream_chunk', { cause: error });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isStreamEvent(value: unknown): value is TauriServerStreamEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TauriServerStreamEvent>;
  return typeof event.requestId === 'string'
    && Number.isSafeInteger(event.sequence)
    && Number(event.sequence) >= 0
    && ['chunk', 'end', 'error'].includes(String(event.kind || ''));
}

function assertBlobId(value: unknown): string {
  const blobId = String(value || '');
  if (!/^[a-z\d._-]{1,128}$/i.test(blobId)) {
    throw new ServerTransportError('invalid_native_blob_id');
  }
  return blobId;
}

let streamRequestSequence = 0;

function createStreamRequestId() {
  streamRequestSequence += 1;
  return globalThis.crypto?.randomUUID?.()
    || `native-${Date.now().toString(36)}-${streamRequestSequence.toString(36)}`;
}

export class TauriServerTransport implements ServerTransport {
  private readonly invokeImpl: InvokeFn;
  private readonly listenImpl: ListenFn;
  private readonly convertFileSrcImpl: (path: string, protocol?: string) => string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TauriServerTransportOptions = {}) {
    this.invokeImpl = options.invokeImpl || invoke;
    this.listenImpl = options.listenImpl || listen;
    this.convertFileSrcImpl = options.convertFileSrcImpl || convertFileSrc;
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async requestJson<TData, TBody>(
    request: ServerRequest<TBody>
  ): Promise<ServerJsonResponse<TData>> {
    const input = this.createNativeInput(request, 'application/json');
    const response = await this.invokeCommand<TauriServerJsonResponse<TData>>(
      TAURI_SERVER_COMMANDS.httpRequest,
      { input }
    );
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
      throw new ServerTransportError('invalid_native_http_status');
    }
    return {
      status: response.status,
      headers: normalizeResponseHeaders(response.headers),
      data: response.body
    };
  }

  async requestBlob<TBody>(request: ServerRequest<TBody>): Promise<ServerBlobResponse> {
    const input = this.createNativeInput(request, '*/*');
    const handle = await this.invokeCommand<TauriServerBlobHandle>(
      TAURI_SERVER_COMMANDS.blobRequest,
      { input }
    );
    const blobId = assertBlobId(handle?.blobId);
    const expectedSize = Number(handle?.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      await this.releaseBlob(blobId);
      throw new ServerTransportError('invalid_native_blob_size');
    }

    let result: ServerBlobResponse | undefined;
    let primaryError: unknown;

    try {
      const headers = normalizeResponseHeaders(handle);
      assertRequestNotAborted(request.signal);
      const blobUrl = this.convertFileSrcImpl(blobId, 'aihblob');
      const response = await this.fetchImpl(blobUrl, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: request.signal
      });
      assertSuccessStatus(response.status);
      const bytes = await response.arrayBuffer();
      const data = new Blob([bytes], {
        type: headers.contentType || 'application/octet-stream'
      });
      if (data.size !== expectedSize) {
        throw new ServerTransportError('native_blob_size_mismatch');
      }
      result = { headers, data, size: data.size };
    } catch (error) {
      primaryError = error;
    }

    try {
      await this.releaseBlob(blobId);
    } catch (releaseError) {
      if (!primaryError) primaryError = releaseError;
    }

    if (primaryError) {
      throw asServerTransportError(primaryError, 'native_blob_read_failed');
    }
    if (!result) throw new ServerTransportError('native_blob_read_failed');
    return result;
  }

  async openSse<TBody>(
    request: ServerRequest<TBody>,
    handlers: ServerSseHandlers
  ): Promise<ServerStreamHandle> {
    assertRequestNotAborted(request.signal);
    const requestId = createStreamRequestId();
    const input = {
      ...this.createNativeInput(request, 'text/event-stream'),
      requestId
    };
    const pendingEvents: TauriServerStreamEvent[] = [];
    let lastSequence = 0;
    let closed = false;
    let abortRequested = false;
    let openAcknowledged = false;
    let preOpenError: ServerTransportError | null = null;
    let cancelPromise: Promise<void> | null = null;
    let unlisten = () => {};
    let onAbort = () => {};
    const deferred = createDeferred();
    const parser = createServerSseParser(handlers.onEvent);

    const close = (reason: 'cancelled' | 'completed' | 'error') => {
      if (closed) return;
      closed = true;
      request.signal?.removeEventListener('abort', onAbort);
      unlisten();
      try {
        handlers.onClose?.(reason);
      } catch (_error) {
        // Consumer cleanup must not change the transport result.
      }
    };

    const fail = (error: unknown) => {
      if (closed) return;
      const streamError = asServerTransportError(error, 'native_stream_failed');
      parser.cancel();
      try {
        handlers.onError?.(streamError);
      } catch (_handlerError) {
        // Preserve the transport error.
      }
      close('error');
      deferred.reject(streamError);
    };

    const processEvent = (event: TauriServerStreamEvent) => {
      if (closed || event.requestId !== requestId) return;
      if (event.sequence <= lastSequence) return;
      if (event.sequence !== lastSequence + 1) {
        fail(new ServerTransportError('native_stream_sequence_gap'));
        return;
      }
      lastSequence = event.sequence;

      try {
        if (event.kind === 'chunk') {
          parser.push(decodeBase64Chunk(String(event.chunkBase64 || '')));
          return;
        }
        if (event.kind === 'end') {
          parser.finish();
          close('completed');
          deferred.resolve();
          return;
        }
        const code = nativeErrorCode(event.errorCode, 'native_stream_failed');
        fail(new ServerTransportError(code, { status: event.status }));
      } catch (error) {
        fail(error);
      }
    };

    const cancel = async () => {
      if (cancelPromise) return cancelPromise;
      cancelPromise = (async () => {
        abortRequested = true;
        if (!openAcknowledged || closed) return;
        parser.cancel();
        close('cancelled');
        deferred.resolve();
        await this.invokeCommand<TauriServerStreamCancelResponse>(
          TAURI_SERVER_COMMANDS.streamCancel,
          { input: { requestId } }
        );
      })();
      return cancelPromise;
    };

    try {
      unlisten = await this.listenImpl<TauriServerStreamEvent>(
        TAURI_SERVER_STREAM_EVENT,
        (event) => {
          if (!isStreamEvent(event.payload) || closed || event.payload.requestId !== requestId) return;
          if (!openAcknowledged) {
            if (pendingEvents.length >= 256) {
              preOpenError = new ServerTransportError('native_stream_open_buffer_overflow');
              return;
            }
            pendingEvents.push(event.payload);
            return;
          }
          processEvent(event.payload);
        }
      );
    } catch (_error) {
      throw new ServerTransportError('native_stream_listener_failed');
    }

    onAbort = () => {
      abortRequested = true;
      if (openAcknowledged) void cancel().catch(() => {});
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    let opened: TauriServerStreamOpenResponse;
    try {
      opened = await this.invokeCommand<TauriServerStreamOpenResponse>(
        TAURI_SERVER_COMMANDS.streamOpen,
        { input }
      );
      const openedRequestId = String(opened?.requestId || '');
      if (!/^[a-z\d._-]{1,128}$/i.test(openedRequestId)) {
        throw new ServerTransportError('invalid_native_stream_request_id');
      }
      if (openedRequestId !== requestId) {
        throw new ServerTransportError('native_stream_request_id_mismatch');
      }
      assertSuccessStatus(opened.status);
      openAcknowledged = true;
    } catch (error) {
      request.signal?.removeEventListener('abort', onAbort);
      unlisten();
      throw error;
    }

    if (preOpenError) {
      await cancel().catch(() => {});
      throw preOpenError;
    }
    if (abortRequested || request.signal?.aborted) {
      await cancel().catch(() => {});
      throw new ServerTransportError('server_request_cancelled');
    }

    try {
      handlers.onOpen?.({ requestId, status: opened.status });
    } catch (error) {
      await cancel().catch(() => {});
      throw asServerTransportError(error, 'server_stream_handler_failed');
    }

    for (const event of pendingEvents) {
      if (closed) break;
      processEvent(event);
    }
    pendingEvents.length = 0;

    return {
      requestId,
      status: opened.status,
      done: deferred.promise,
      cancel
    };
  }

  private createNativeInput<TBody>(
    request: ServerRequest<TBody>,
    defaultAccept: string
  ): TauriServerRequestInput<TBody> {
    assertRequestNotAborted(request.signal);
    const normalized = validateRequest(request);
    assertNativeBodyIsCredentialFree(request.body);
    const headers = selectSafeRequestHeaders(request.headers, {
      accept: defaultAccept,
      ...(request.body !== undefined ? { contentType: 'application/json' } : {})
    }, request.body !== undefined);

    return {
      profileId: normalized.profileId,
      method: normalized.method,
      path: normalized.path,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(headers.accept ? { accept: headers.accept } : {}),
      ...(headers.contentType ? { contentType: headers.contentType } : {}),
      ...(normalized.timeoutMs !== undefined ? { timeoutMs: normalized.timeoutMs } : {})
    };
  }

  private async releaseBlob(blobId: string) {
    await this.invokeCommand<TauriServerBlobReleaseResponse>(
      TAURI_SERVER_COMMANDS.blobRelease,
      { input: { blobId } }
    );
  }

  private async invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.invokeImpl<T>(command, args);
    } catch (error) {
      throw fromNativeCommandError(error);
    }
  }
}
