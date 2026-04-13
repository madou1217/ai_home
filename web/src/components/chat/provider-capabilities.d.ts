import type { Provider } from '@/types';

export declare function supportsExternalPending(provider?: Provider | string): boolean;

export declare function supportsSessionWatchPending(provider?: Provider | string): boolean;

export declare function supportsBackgroundRunWatch(provider?: Provider | string): boolean;

export declare function supportsToolBoundaryQueue(provider?: Provider | string, apiKeyMode?: boolean): boolean;

export declare function resolveQueueMode(provider?: Provider | string, apiKeyMode?: boolean): 'after_turn' | 'after_tool_call';
