import type {
  ServerHttpMethod,
  ServerRequest,
  ServerRequestHeaders
} from './contract';
import { ServerTransportError } from './errors';

const ALLOWED_METHODS = new Set<ServerHttpMethod>([
  'DELETE',
  'GET',
  'PATCH',
  'POST',
  'PUT'
]);

const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'host',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-management-key'
]);

const NATIVE_CREDENTIAL_FIELD_NAMES = new Set([
  'authorization',
  'managementkey'
]);

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120 * 1000;

export interface SafeRequestHeaders {
  accept?: string;
  contentType?: string;
}

function hasInvalidHeaderCharacters(value: string) {
  return /[\r\n\0]/.test(value);
}

function normalizeCredentialFieldName(value: string) {
  return value.replace(/[-_\s]/g, '').toLowerCase();
}

export function normalizeServerPath(value: string): string {
  const path = String(value || '');
  if (!path || path !== path.trim() || path.includes('\\') || path.includes('#')) {
    throw new ServerTransportError('invalid_server_path');
  }

  let parsed: URL;
  try {
    parsed = new URL(path, 'https://aih-server.invalid');
  } catch (error) {
    throw new ServerTransportError('invalid_server_path', { cause: error });
  }

  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ServerTransportError('invalid_server_path');
  }
  if (parsed.origin !== 'https://aih-server.invalid') {
    throw new ServerTransportError('invalid_server_path');
  }
  if (parsed.pathname !== '/v0' && !parsed.pathname.startsWith('/v0/')) {
    throw new ServerTransportError('invalid_server_path');
  }

  return `${parsed.pathname}${parsed.search}`;
}

export function normalizeProfileId(value: string): string {
  const profileId = String(value || '').trim();
  if (!profileId || profileId.length > 128 || /[\r\n\0]/.test(profileId)) {
    throw new ServerTransportError('invalid_server_profile_id');
  }
  return profileId;
}

export function normalizeMethod(value: ServerHttpMethod): ServerHttpMethod {
  const method = String(value || '').toUpperCase() as ServerHttpMethod;
  if (!ALLOWED_METHODS.has(method)) {
    throw new ServerTransportError('unsupported_server_http_method');
  }
  return method;
}

export function normalizeTimeoutMs(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ServerTransportError('invalid_server_timeout');
  }
  return value;
}

export function selectSafeRequestHeaders(
  headers: ServerRequestHeaders | undefined,
  defaults: SafeRequestHeaders = {},
  hasBody = false
): SafeRequestHeaders {
  const selected: SafeRequestHeaders = { ...defaults };

  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.trim().toLowerCase();
    const value = String(rawValue || '').trim();

    if (FORBIDDEN_HEADER_NAMES.has(name) || name.startsWith('x-aih-')) {
      throw new ServerTransportError('forbidden_server_request_header');
    }
    if (!value || hasInvalidHeaderCharacters(value)) {
      throw new ServerTransportError('invalid_server_request_header');
    }
    if (name === 'accept') selected.accept = value;
    if (name === 'content-type') selected.contentType = value;
  }

  if (!hasBody && selected.contentType) {
    throw new ServerTransportError('server_content_type_without_body');
  }

  return selected;
}

export function validateRequest<TBody>(request: ServerRequest<TBody>) {
  const method = normalizeMethod(request.method);
  if (method === 'GET' && request.body !== undefined) {
    throw new ServerTransportError('server_request_body_not_allowed');
  }

  return {
    profileId: normalizeProfileId(request.profileId),
    method,
    path: normalizeServerPath(request.path),
    timeoutMs: normalizeTimeoutMs(request.timeoutMs)
  };
}

/** Native HTTP auth is resolved by Rust from the profile and OS Keyring. */
export function assertNativeBodyIsCredentialFree(body: unknown): void {
  if (body === undefined || body === null || typeof body !== 'object') return;

  const pending: Array<{ value: object; path: string[] }> = [{ value: body, path: [] }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.value)) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        if (item !== null && typeof item === 'object') {
          pending.push({ value: item, path: current.path });
        }
      }
      continue;
    }

    for (const [key, value] of Object.entries(current.value)) {
      const fieldPath = [...current.path, key];
      if (NATIVE_CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(key))) {
        throw new ServerTransportError('native_request_contains_management_credential');
      }
      if (value !== null && typeof value === 'object') {
        pending.push({ value, path: fieldPath });
      }
    }
  }
}

export function assertRequestNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ServerTransportError('server_request_cancelled');
  }
}
