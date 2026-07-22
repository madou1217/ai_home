import type { ChatMessage } from '@/types';

export declare function isRenderableChatMessage(message: ChatMessage | null | undefined): boolean;
export declare function filterRenderableChatMessages(messages: ChatMessage[] | null | undefined): ChatMessage[];
