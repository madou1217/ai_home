export class ServerTransportError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    code: string,
    options: {
      message?: string;
      status?: number;
      cause?: unknown;
    } = {}
  ) {
    super(options.message || code);
    this.name = 'ServerTransportError';
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
  }
}

const SAFE_NATIVE_CODE = /^[a-z][a-z0-9_.:-]{0,95}$/i;
const UNSAFE_NATIVE_MESSAGE_PATTERNS = [
  /(?:https?|file|tauri):\/\//i,
  /(?:bearer|authorization)\s+\S+/i,
  /(?:token|secret|api[_ -]?key|management[_ -]?key|authorization)\s*[:=]\s*\S+/i,
  /(?:^|\s)at\s+\S+\s*\(/,
  /(?:^|\s)\/(?:Users|home|private|tmp)\//,
  /[a-z]:\\/i
];

function safeNativeErrorCode(value: unknown, fallback: string) {
  const candidate = typeof value === 'string' ? value : '';
  return SAFE_NATIVE_CODE.test(candidate) ? candidate : fallback;
}

function safeNativeErrorMessage(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const message = value.trim();
  if (!message || message.length > 256 || /[\r\n\0]/.test(message)) return undefined;
  return UNSAFE_NATIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    ? undefined
    : message;
}

function safeNativeErrorStatus(value: unknown) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 100
    && value <= 599
    ? value
    : undefined;
}

/** Maps only the documented Rust error envelope; arbitrary rejection data is dropped. */
export function fromNativeCommandError(
  error: unknown,
  fallbackCode = 'native_command_failed'
): ServerTransportError {
  const source = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const code = safeNativeErrorCode(source?.code ?? error, fallbackCode);
  const message = safeNativeErrorMessage(source?.message);
  const status = safeNativeErrorStatus(source?.status);
  return new ServerTransportError(code, {
    ...(message ? { message } : {}),
    ...(status !== undefined ? { status } : {})
  });
}

export function asServerTransportError(
  error: unknown,
  fallbackCode: string
): ServerTransportError {
  if (error instanceof ServerTransportError) return error;
  return new ServerTransportError(fallbackCode, { cause: error });
}
