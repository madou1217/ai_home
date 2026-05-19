import type { BlockParser } from './types';

export const oaiMemParser: BlockParser = {
  name: 'common.oai-mem',
  parse: ({ lines, index, inCodeBlock }) => {
    if (inCodeBlock) return null;
    const line = lines[index];

    if (line === '<oai-mem-citation>') {
      const tagLines: string[] = [];
      let cur = index + 1;
      let closed = false;
      while (cur < lines.length) {
        if (lines[cur] === '</oai-mem-citation>') {
          closed = true;
          break;
        }
        tagLines.push(lines[cur]);
        cur += 1;
      }

      if (closed) {
        return {
          consumed: cur - index + 1,
          block: { type: 'tag', name: 'oai-mem-citation', value: tagLines.join('\n').trim() }
        };
      }
    }

    return null;
  }
};

export const oaiMemParsers = [oaiMemParser];