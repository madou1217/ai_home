import type { BlockParser } from './types';

export const genericXmlParser: BlockParser = {
  name: 'common.xml',
  parse: ({ lines, index, inCodeBlock }) => {
    if (inCodeBlock) return null;
    const line = lines[index];

    const tagStartMatch = line.match(/^<([a-zA-Z0-9_.-]+)>$/);
    if (tagStartMatch) {
      const tagName = tagStartMatch[1];
      let tempIndex = index + 1;
      let closed = false;
      while (tempIndex < lines.length) {
        if (lines[tempIndex] === `</${tagName}>`) {
          closed = true;
          break;
        }
        tempIndex += 1;
      }
      if (closed) {
        const tagLines: string[] = [];
        let cur = index + 1;
        while (cur < lines.length && lines[cur] !== `</${tagName}>`) {
          tagLines.push(lines[cur]);
          cur += 1;
        }
        return {
          consumed: cur - index + 1,
          block: { type: 'tag', name: tagName, value: tagLines.join('\n').trim() }
        };
      }
    }

    const orphanCloseMatch = line.match(/^<\/([a-zA-Z0-9_.-]+)>$/);
    if (orphanCloseMatch) {
      return {
        consumed: 1,
        block: { type: 'tag', name: orphanCloseMatch[1], value: '', orphanClose: true }
      };
    }

    return null;
  }
};

export const thinkingParser: BlockParser = {
  name: 'common.thinking',
  parse: ({ lines, index }) => {
    if (lines[index] === ':::thinking') {
      const thinkingLines: string[] = [];
      let cur = index + 1;
      while (cur < lines.length && lines[cur] !== ':::') {
        thinkingLines.push(lines[cur]);
        cur += 1;
      }
      if (cur < lines.length && lines[cur] === ':::') {
        cur += 1;
      }
      return {
        consumed: cur - index,
        block: { type: 'thinking', value: thinkingLines.join('\n').trim() }
      };
    }
    return null;
  }
};

export const commonParsers = [genericXmlParser, thinkingParser];
