import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios';
import { getActiveControlPlaneProfileId } from './control-plane-selection';
import {
  requestNativeServerBlob,
  requestNativeServerJson
} from './native-server-transport';

function buildRequestPath(config: InternalAxiosRequestConfig) {
  const requestUri = axios.getUri(config);
  const parsed = new URL(requestUri, 'https://aih-native.invalid');
  return `${parsed.pathname}${parsed.search}`;
}

function getHeader(config: InternalAxiosRequestConfig, name: string) {
  const value = config.headers?.get?.(name);
  return value === undefined || value === null ? '' : String(value);
}

function parseJsonRequestBody(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeMethod(value: unknown) {
  return String(value || 'GET').toUpperCase() as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
}

function bridgeAbortSignal(signal: InternalAxiosRequestConfig['signal']) {
  if (!signal) return { signal: undefined, cleanup: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener?.('abort', abort);
  return {
    signal: controller.signal,
    cleanup: () => signal.removeEventListener?.('abort', abort)
  };
}

function responseHeaders(input: { contentType?: string; contentDisposition?: string }) {
  return {
    ...(input.contentType ? { 'content-type': input.contentType } : {}),
    ...(input.contentDisposition ? { 'content-disposition': input.contentDisposition } : {})
  };
}

function createAxiosResponse<T>(
  config: InternalAxiosRequestConfig,
  status: number,
  headers: Record<string, string>,
  data: T
): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: String(status),
    headers,
    config
  };
}

function assertAxiosStatus<T>(
  config: InternalAxiosRequestConfig,
  response: AxiosResponse<T>
) {
  const accepted = config.validateStatus
    ? config.validateStatus(response.status)
    : response.status >= 200 && response.status < 300;
  if (accepted) return response;
  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    undefined,
    response
  );
}

function normalizeTransportError(error: unknown, config: InternalAxiosRequestConfig) {
  if (error instanceof AxiosError) return error;
  const source = error as { code?: unknown; message?: unknown; status?: unknown };
  const status = Number(source?.status);
  const response = Number.isInteger(status)
    ? createAxiosResponse(config, status, {}, null)
    : undefined;
  return new AxiosError(
    String(source?.message || source?.code || 'native_server_request_failed'),
    source?.code === 'server_request_cancelled'
      ? AxiosError.ERR_CANCELED
      : String(source?.code || AxiosError.ERR_NETWORK),
    config,
    undefined,
    response
  );
}

export function createNativeAxiosAdapter(): AxiosAdapter {
  return async (config) => {
    const profileId = getActiveControlPlaneProfileId();
    if (!profileId) throw normalizeTransportError(new Error('missing_active_server_profile'), config);
    const abort = bridgeAbortSignal(config.signal);
    const body = parseJsonRequestBody(config.data);
    const request = {
      profileId,
      method: normalizeMethod(config.method),
      path: buildRequestPath(config),
      body,
      accept: getHeader(config, 'accept') || undefined,
      // Axios may synthesize Content-Type for bodyless requests. The native
      // transport correctly rejects that invalid HTTP shape, so only forward
      // Content-Type when an actual request body crosses the IPC boundary.
      contentType: body !== undefined
        ? (getHeader(config, 'content-type') || undefined)
        : undefined,
      timeoutMs: config.timeout || undefined,
      signal: abort.signal
    };

    try {
      if (config.responseType === 'blob') {
        const result = await requestNativeServerBlob(request);
        return createAxiosResponse(
          config,
          200,
          responseHeaders(result.headers),
          result.data
        );
      }
      const result = await requestNativeServerJson(request);
      return assertAxiosStatus(config, createAxiosResponse(
        config,
        result.status,
        responseHeaders(result.headers),
        result.data
      ));
    } catch (error) {
      throw normalizeTransportError(error, config);
    } finally {
      abort.cleanup();
    }
  };
}
