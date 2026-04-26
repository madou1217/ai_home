import type { Provider } from '@/types';

export declare function getThinkingStatusText(provider?: Provider | string): string;

export declare function getProcessingStatusText(): string;

export declare function getGeneratingStatusText(): string;

export declare function shouldUseExternalPending(provider?: Provider | string): boolean;

export declare function normalizePendingStatusText(rawText?: string, provider?: Provider | string): string;
