import type { MessageBlock } from '../message-structure';

export interface ParserContext {
  lines: string[];
  index: number;
  inCodeBlock: boolean;
}

export interface ParseResult {
  consumed: number;
  block?: MessageBlock;
}

export interface BlockParser {
  name: string;
  parse: (ctx: ParserContext) => ParseResult | null;
}
