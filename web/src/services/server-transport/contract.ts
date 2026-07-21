export type ServerJsonPrimitive = boolean | number | string | null;

export type ServerJsonValue =
  | ServerJsonPrimitive
  | ServerJsonValue[]
  | { [key: string]: ServerJsonValue };

export type ServerHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

/**
 * Only `accept` and `content-type` cross the native IPC boundary. Adapters
 * reject credential-bearing headers and ignore other entries.
 */
export type ServerRequestHeaders = Readonly<Record<string, string>>;

export interface ServerRequest<TBody = ServerJsonValue> {
  profileId: string;
  method: ServerHttpMethod;
  /** A relative Server API path whose pathname is `/v0` or starts with `/v0/`. */
  path: string;
  body?: TBody;
  headers?: ServerRequestHeaders;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ServerResponseHeaders {
  contentType?: string;
  contentDisposition?: string;
}

export interface ServerJsonResponse<TData = ServerJsonValue> {
  status: number;
  headers: ServerResponseHeaders;
  data: TData;
}

export interface ServerBlobResponse {
  headers: ServerResponseHeaders;
  data: Blob;
  size: number;
}

export interface ServerSseEvent {
  type: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface ServerStreamOpenMetadata {
  requestId: string;
  status: number;
}

export type ServerStreamCloseReason = 'cancelled' | 'completed' | 'error';

export interface ServerSseHandlers {
  onEvent: (event: ServerSseEvent) => void;
  onOpen?: (metadata: ServerStreamOpenMetadata) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: ServerStreamCloseReason) => void;
}

export interface ServerStreamHandle {
  readonly requestId: string;
  readonly status: number;
  /** Resolves on a normal end or cancellation and rejects on a stream error. */
  readonly done: Promise<void>;
  /** Idempotent. POST streams are never reopened or retried by the transport. */
  cancel: () => Promise<void>;
}

export interface ServerTransport {
  requestJson<TData = ServerJsonValue, TBody = ServerJsonValue>(
    request: ServerRequest<TBody>
  ): Promise<ServerJsonResponse<TData>>;

  requestBlob<TBody = ServerJsonValue>(
    request: ServerRequest<TBody>
  ): Promise<ServerBlobResponse>;

  openSse<TBody = ServerJsonValue>(
    request: ServerRequest<TBody>,
    handlers: ServerSseHandlers
  ): Promise<ServerStreamHandle>;
}
