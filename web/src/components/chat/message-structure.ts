import type { ChatMessage } from '@/types';

export type ToolItem = {
  name: string;
  body: string;
  result?: string;
};

export type MessageBlock =
  | { type: 'text'; value: string }
  | { type: 'tool_use'; name: string; body: string; result?: string }
  | { type: 'tool_group'; items: ToolItem[] }
  | { type: 'thinking'; value: string };

export type StructuredTaskStatus = 'pending' | 'in_progress' | 'completed';

export type StructuredTaskItem = {
  content: string;
  status: StructuredTaskStatus;
};

export type StructuredChecklist = {
  kind: 'todo' | 'plan';
  sourceTool: string;
  title: string;
  explanation: string;
  items: StructuredTaskItem[];
  result?: string;
};

type StructuredToolAdapter = {
  match: (name: string) => boolean;
  parse: (body: string, result?: string, sourceTool?: string) => StructuredChecklist | null;
};

function mergeAdjacentToolBlocks(blocks: MessageBlock[]): MessageBlock[] {
  const merged: MessageBlock[] = [];
  let toolBuffer: ToolItem[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      merged.push({ type: 'tool_use', ...toolBuffer[0] });
    } else {
      merged.push({ type: 'tool_group', items: toolBuffer });
    }
    toolBuffer = [];
  };

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolBuffer.push(block);
      continue;
    }
    flushTools();
    merged.push(block);
  }
  flushTools();
  return merged;
}

export function parseMessageBlocks(content: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const lines = String(content || '').split('\n');
  let index = 0;
  let textBuffer: string[] = [];

  const flushText = () => {
    const text = textBuffer.join('\n').trim();
    if (text) blocks.push({ type: 'text', value: text });
    textBuffer = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const toolMatch = line.match(/^:::tool\{name="([^"]+)"\}$/);
    if (toolMatch) {
      flushText();
      const name = toolMatch[1];
      const bodyLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== ':::') {
        bodyLines.push(lines[index]);
        index += 1;
      }
      index += 1;

      let result: string | undefined;
      while (index < lines.length && lines[index].trim() === '') index += 1;
      if (index < lines.length && lines[index] === ':::tool-result') {
        const resultLines: string[] = [];
        index += 1;
        while (index < lines.length && lines[index] !== ':::') {
          resultLines.push(lines[index]);
          index += 1;
        }
        index += 1;
        result = resultLines.join('\n').trim();
      }

      blocks.push({
        type: 'tool_use',
        name,
        body: bodyLines.join('\n').trim(),
        result
      });
      continue;
    }

    if (line === ':::thinking') {
      flushText();
      const thinkingLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== ':::') {
        thinkingLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'thinking', value: thinkingLines.join('\n').trim() });
      continue;
    }

    const oldToolMatch = line.match(/^\[Tool: ([^\]]+)\]$/);
    if (oldToolMatch) {
      flushText();
      blocks.push({ type: 'tool_use', name: oldToolMatch[1], body: '' });
      index += 1;
      continue;
    }
    if (line === '[Tool Result]') {
      index += 1;
      continue;
    }
    if (line === ':::tool-result') {
      index += 1;
      while (index < lines.length && lines[index] !== ':::') index += 1;
      index += 1;
      continue;
    }

    const codexDirective = line.match(/^::([a-z-]+)\{(.+)\}$/);
    if (codexDirective) {
      flushText();
      const command = codexDirective[1];
      const attrs = codexDirective[2];
      const cwdMatch = attrs.match(/cwd="([^"]+)"/);
      const branchMatch = attrs.match(/branch="([^"]+)"/);
      let body = command;
      if (cwdMatch) body += '\n# cwd: ' + cwdMatch[1];
      if (branchMatch) body += '\n# branch: ' + branchMatch[1];
      blocks.push({ type: 'tool_use', name: 'Git', body });
      index += 1;
      continue;
    }

    textBuffer.push(line);
    index += 1;
  }

  flushText();
  if (blocks.length === 0) {
    blocks.push({ type: 'text', value: String(content || '') });
  }
  return mergeAdjacentToolBlocks(blocks);
}

export function normalizeTaskStatus(status: string): StructuredTaskStatus {
  const raw = String(status || '').trim().toLowerCase();
  if (raw === 'completed' || raw === 'done' || raw === 'success') return 'completed';
  if (raw === 'in_progress' || raw === 'in-progress' || raw === 'active' || raw === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

export function parseTodoItems(body: string): StructuredTaskItem[] | null {
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const items = parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const content = String(item.content || item.text || item.title || '').trim();
        if (!content) return null;
        return {
          content,
          status: normalizeTaskStatus(String(item.status || 'pending'))
        };
      })
      .filter((item): item is StructuredTaskItem => Boolean(item));
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

export function parsePlanItems(body: string): { explanation: string; items: StructuredTaskItem[] } | null {
  try {
    const parsed = JSON.parse(body);
    const sourceItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tasks)
        ? parsed.tasks
        : Array.isArray(parsed?.plan)
          ? parsed.plan
          : Array.isArray(parsed?.items)
            ? parsed.items
            : null;
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) return null;

    const items = sourceItems
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const content = String(item.content || item.step || item.title || item.task || '').trim();
        if (!content) return null;
        return {
          content,
          status: normalizeTaskStatus(String(item.status || 'pending'))
        };
      })
      .filter((item): item is StructuredTaskItem => Boolean(item));

    if (items.length === 0) return null;
    return {
      explanation: String(parsed?.explanation || parsed?.summary || '').trim(),
      items
    };
  } catch {
    return null;
  }
}

const structuredToolAdapters: StructuredToolAdapter[] = [
  {
    match: (name) => name === 'TodoWrite',
    parse: (body, _result, sourceTool = 'TodoWrite') => {
      const items = parseTodoItems(body);
      if (!items) return null;
      return {
        kind: 'todo',
        sourceTool,
        title: 'Todo',
        explanation: '',
        items
      };
    }
  },
  {
    match: (name) => name === 'Task' || name === 'update_plan',
    parse: (body, result, sourceTool = 'Task') => {
      const parsed = parsePlanItems(body);
      if (!parsed) return null;
      return {
        kind: 'plan',
        sourceTool,
        title: 'Plan',
        explanation: parsed.explanation,
        items: parsed.items,
        result
      };
    }
  }
];

export function parseStructuredChecklist(name: string, body: string, result?: string): StructuredChecklist | null {
  const adapter = structuredToolAdapters.find((item) => item.match(String(name || '').trim()));
  if (!adapter) return null;
  return adapter.parse(body, result, name);
}

export function countChecklistProgress(items: StructuredTaskItem[]) {
  const totalCount = items.length;
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const activeCount = items.filter((item) => item.status !== 'completed').length;
  return {
    totalCount,
    completedCount,
    activeCount
  };
}

export function findLatestActiveChecklist(messages: ChatMessage[]): StructuredChecklist | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== 'assistant') continue;
    const blocks = parseMessageBlocks(message.content || '');
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block.type !== 'tool_use') continue;
      const checklist = parseStructuredChecklist(block.name, block.body, block.result);
      if (!checklist) continue;
      return countChecklistProgress(checklist.items).activeCount > 0 ? checklist : null;
    }
  }
  return null;
}
