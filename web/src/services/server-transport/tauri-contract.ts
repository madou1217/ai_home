import type { ServerHttpMethod, ServerJsonValue } from './contract';

export const TAURI_SERVER_COMMANDS = Object.freeze({
  httpRequest: 'desktop_http_request',
  blobRequest: 'desktop_blob_request',
  blobRelease: 'desktop_blob_release',
  streamOpen: 'desktop_stream_open',
  streamCancel: 'desktop_stream_cancel'
} as const);

export const TAURI_SERVER_STREAM_EVENT = 'aih://server-stream';

export interface TauriServerRequestInput<TBody = ServerJsonValue> {
  requestId?: string;
  profileId: string;
  method: ServerHttpMethod;
  path: string;
  body?: TBody;
  accept?: string;
  contentType?: string;
  timeoutMs?: number;
}

export interface TauriServerResponseHeaders {
  contentType?: string;
  contentDisposition?: string;
}

export interface TauriServerJsonResponse<TData = ServerJsonValue> {
  status: number;
  headers?: TauriServerResponseHeaders;
  body: TData;
}

export interface TauriServerBlobHandle {
  blobId: string;
  contentType: string;
  contentDisposition?: string;
  size: number;
}

export interface TauriServerBlobReleaseResponse {
  released: boolean;
}

export interface TauriServerStreamOpenResponse {
  requestId: string;
  status: number;
}

export interface TauriServerStreamCancelResponse {
  cancelled?: boolean;
}

export type TauriServerStreamEventKind = 'chunk' | 'end' | 'error';

export interface TauriServerStreamEvent {
  requestId: string;
  sequence: number;
  kind: TauriServerStreamEventKind;
  status?: number;
  chunkBase64?: string;
  errorCode?: string;
}
