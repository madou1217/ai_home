import type { BlockParser } from './types';

export const claudeToolParser: BlockParser = {
  name: 'claude.tool',
  parse: ({ lines, index }) => {
    const line = lines[index];
    const oldToolMatch = line.match(/^\[Tool: ([^\]]+)\]$/);
    if (oldToolMatch) {
      return {
        consumed: 1,
        block: { type: 'tool_use', name: oldToolMatch[1], body: '' }
      };
    }
    return null;
  }
};

export const claudeToolResultNoiseParser: BlockParser = {
  name: 'claude.tool_result_noise',
  parse: ({ lines, index }) => {
    const line = lines[index];
    if (line === '[Tool Result]') {
      return {
        consumed: 1
      };
    }
    return null;
  }
};

export const claudeParsers = [claudeToolParser, claudeToolResultNoiseParser];
