import type { Provider } from '@/types';

export interface RetryStatus {
  readonly provider?: Provider | string;
  readonly phase?: string;
  readonly source?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryAfterMs?: number;
  readonly retryAt?: number;
  readonly status?: number;
  readonly reason?: string;
  readonly message?: string;
}

export interface RetryCountdown {
  readonly event: RetryStatus;
  readonly provider: Provider | string;
  readonly startedAt: number;
  readonly retryAt: number;
}

interface StreamFailureStatus {
  readonly message?: string;
  readonly retryable?: boolean;
}

export declare function getThinkingStatusText(provider?: Provider | string): string;

export declare function getProcessingStatusText(): string;

export declare function getGeneratingStatusText(): string;

export declare function formatRetryStatusText(
  event?: RetryStatus,
  provider?: Provider | string,
  now?: number
): string;

export declare function createRetryCountdown(
  event?: RetryStatus,
  provider?: Provider | string,
  startedAt?: number
): RetryCountdown;

export declare function formatRetryCountdownStatus(
  countdown?: RetryCountdown | null,
  now?: number
): string;

export declare function getRetryCountdownDelayMs(
  countdown?: RetryCountdown | null,
  now?: number
): number | null;

export declare function formatStreamFailureText(
  failure?: StreamFailureStatus,
  provider?: Provider | string
): string;

export declare function shouldUseExternalPending(provider?: Provider | string): boolean;

export declare function normalizePendingStatusText(rawText?: string, provider?: Provider | string): string;
