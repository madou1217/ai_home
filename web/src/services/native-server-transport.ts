import {
  createServerTransport,
  isTauriServerRuntime,
  type ServerBlobResponse,
  type ServerHttpMethod,
  type ServerJsonResponse,
  type ServerJsonValue,
  type ServerRequest,
  type ServerSseHandlers,
  type ServerStreamHandle,
  type ServerTransport
} from './server-transport';

let transportPromise: Promise<ServerTransport> | null = null;

export function isNativeServerTransportAvailable() {
  return isTauriServerRuntime();
}

export function getNativeServerTransport() {
  if (!isNativeServerTransportAvailable()) {
    throw new Error('native_server_transport_unavailable');
  }
  transportPromise ||= createServerTransport({ runtime: 'tauri' });
  return transportPromise;
}

export interface NativeServerRequestInput<TBody = unknown> {
  profileId: string;
  method: ServerHttpMethod;
  path: string;
  body?: TBody;
  accept?: string;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function toServerRequest<TBody>(input: NativeServerRequestInput<TBody>) {
  return {
    profileId: input.profileId,
    method: input.method,
    path: input.path,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(
      input.accept || input.contentType
        ? {
            headers: {
              ...(input.accept ? { accept: input.accept } : {}),
              ...(input.contentType ? { 'content-type': input.contentType } : {})
            }
          }
        : {}
    ),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  } as ServerRequest<ServerJsonValue>;
}

export async function requestNativeServerJson<TData = unknown, TBody = unknown>(
  input: NativeServerRequestInput<TBody>
): Promise<ServerJsonResponse<TData>> {
  const transport = await getNativeServerTransport();
  return transport.requestJson<TData, ServerJsonValue>(toServerRequest(input));
}

export async function requestNativeServerBlob<TBody = unknown>(
  input: NativeServerRequestInput<TBody>
): Promise<ServerBlobResponse> {
  const transport = await getNativeServerTransport();
  return transport.requestBlob<ServerJsonValue>(toServerRequest(input));
}

export async function openNativeServerSse<TBody = unknown>(
  input: NativeServerRequestInput<TBody>,
  handlers: ServerSseHandlers
): Promise<ServerStreamHandle> {
  const transport = await getNativeServerTransport();
  return transport.openSse<ServerJsonValue>(toServerRequest(input), handlers);
}
