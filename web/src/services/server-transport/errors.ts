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

export function asServerTransportError(
  error: unknown,
  fallbackCode: string
): ServerTransportError {
  if (error instanceof ServerTransportError) return error;
  return new ServerTransportError(fallbackCode, { cause: error });
}
