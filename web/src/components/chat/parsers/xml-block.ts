import type { MessageBlock } from '../message-structure';

interface XmlBlockOptions {
  tagName: string;
  lines: string[];
  index: number;
  inCodeBlock: boolean;
}

export interface XmlBlockResult {
  consumed: number;
  value: string;
}

export function decodeBasicXmlEntities(value: string) {
  let current = String(value || '');
  for (let index = 0; index < 3; index += 1) {
    const next = current
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === current) break;
    current = next;
  }
  return current;
}

export function parseXmlBlock(options: XmlBlockOptions): XmlBlockResult | null {
  if (options.inCodeBlock) return null;

  const tagName = String(options.tagName || '').trim();
  if (!tagName) return null;

  const line = decodeBasicXmlEntities(String(options.lines[options.index] || '').trim());
  const singleLinePattern = new RegExp(`^<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>$`, 'i');
  const singleLineMatch = line.match(singleLinePattern);
  if (singleLineMatch) {
    return {
      consumed: 1,
      value: decodeBasicXmlEntities(singleLineMatch[1]).trim()
    };
  }

  const openPattern = new RegExp(`^<${tagName}(?:\\s+[^>]*)?>$`, 'i');
  if (!openPattern.test(line)) return null;

  const tagLines: string[] = [];
  let cursor = options.index + 1;
  while (cursor < options.lines.length) {
    const currentLine = decodeBasicXmlEntities(String(options.lines[cursor] || '').trim());
    if (currentLine.toLowerCase() === `</${tagName.toLowerCase()}>`) {
      return {
        consumed: cursor - options.index + 1,
        value: tagLines.join('\n').trim()
      };
    }
    tagLines.push(decodeBasicXmlEntities(options.lines[cursor]));
    cursor += 1;
  }

  return null;
}

export function buildTagBlock(name: string, value: string): MessageBlock {
  return {
    type: 'tag',
    name,
    value
  };
}
