import type { BlockParser } from './types';
import { buildTagBlock, parseXmlBlock } from './xml-block';

function decodeOaiMemEntities(value: string) {
  let current = String(value || '');
  for (let index = 0; index < 2; index += 1) {
    const next = current
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === current) break;
    current = next;
  }
  return current;
}

function extractInlineOaiMemBlock(lines: string[], index: number) {
  const tagName = 'oai-mem-citation';
  const openPattern = new RegExp(`^\\s*<${tagName}(?:\\s+[^>]*)?>\\s*$`, 'i');
  const closePattern = new RegExp(`</${tagName}>`, 'i');
  const bodyLines: string[] = [];
  let cursor = index;
  let opened = false;

  while (cursor < lines.length) {
    let line = decodeOaiMemEntities(lines[cursor] || '');
    if (!opened) {
      const openMatch = line.match(openPattern);
      if (!openMatch) return null;
      line = '';
      opened = true;
    }

    const closeMatch = line.match(closePattern);
    if (closeMatch && closeMatch.index != null) {
      bodyLines.push(line.slice(0, closeMatch.index));
      return {
        consumed: cursor - index + 1,
        value: bodyLines.join('\n').trim()
      };
    }

    bodyLines.push(line);
    cursor += 1;
  }

  return null;
}

export const oaiMemParser: BlockParser = {
  name: 'common.oai-mem',
  parse: (ctx) => {
    const parsed = parseXmlBlock({ ...ctx, tagName: 'oai-mem-citation' });
    const result = parsed || extractInlineOaiMemBlock(ctx.lines, ctx.index);
    if (!result) return null;
    return {
      consumed: result.consumed,
      block: buildTagBlock('oai-mem-citation', decodeOaiMemEntities(result.value))
    };
  }
};

export const oaiMemParsers = [oaiMemParser];
