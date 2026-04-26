import type { MessageBlock } from './message-structure';

export declare function getRenderablePendingBlocks(blocks: MessageBlock[]): MessageBlock[];
export declare function hasRenderablePendingBlocks(blocks: MessageBlock[]): boolean;
export declare function shouldRenderPendingBlockAsPlainText(block: MessageBlock): boolean;
export declare function normalizePendingTextBlock(value: string): string;
