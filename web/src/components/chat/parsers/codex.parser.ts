import type { BlockParser } from './types';

export const codexToolParser: BlockParser = {
  name: 'codex.tool',
  parse: ({ lines, index }) => {
    const line = lines[index];
    const toolMatch = line.match(/^:::tool\{name="([^"]+)"\}$/);
    if (toolMatch) {
      const name = toolMatch[1];
      const bodyLines: string[] = [];
      let cur = index + 1;
      while (cur < lines.length && lines[cur] !== ':::') {
        bodyLines.push(lines[cur]);
        cur += 1;
      }
      if (cur < lines.length && lines[cur] === ':::') {
        cur += 1;
      }

      let result: string | undefined;
      while (cur < lines.length && lines[cur].trim() === '') cur += 1;
      if (cur < lines.length && lines[cur] === ':::tool-result') {
        const resultLines: string[] = [];
        cur += 1;
        while (cur < lines.length && lines[cur] !== ':::') {
          resultLines.push(lines[cur]);
          cur += 1;
        }
        if (cur < lines.length && lines[cur] === ':::') {
          cur += 1;
        }
        result = resultLines.join('\n').trim();
      }

      return {
        consumed: cur - index,
        block: {
          type: 'tool_use',
          name,
          body: bodyLines.join('\n').trim(),
          result
        }
      };
    }
    return null;
  }
};

export const codexDirectiveParser: BlockParser = {
  name: 'codex.directive',
  parse: ({ lines, index }) => {
    const line = lines[index];
    const codexDirective = line.match(/^::([a-z-]+)\{(.+)\}$/);
    if (codexDirective) {
      const command = codexDirective[1];
      const attrs = codexDirective[2];
      const cwdMatch = attrs.match(/cwd="([^"]+)"/);
      const branchMatch = attrs.match(/branch="([^"]+)"/);
      let body = command;
      if (cwdMatch) body += '\n# cwd: ' + cwdMatch[1];
      if (branchMatch) body += '\n# branch: ' + branchMatch[1];
      return {
        consumed: 1,
        block: { type: 'tool_use', name: 'Git', body }
      };
    }
    return null;
  }
};

export const codexParsers = [codexToolParser, codexDirectiveParser];
