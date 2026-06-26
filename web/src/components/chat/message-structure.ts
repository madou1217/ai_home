import type { ChatMessage } from '@/types';
import { registeredParsers } from './parsers';

export type ToolItem = {
  name: string;
  body: string;
  result?: string;
};

export type MessageBlock =
  | { type: 'text'; value: string }
  | { type: 'tool_use'; name: string; body: string; result?: string }
  | { type: 'tool_group'; items: ToolItem[] }
  | { type: 'thinking'; value: string }
  | { type: 'tag'; name: string; value: string; orphanClose?: boolean };

export type StructuredTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type ChecklistState = 'waiting' | 'running' | 'attention' | 'failed' | 'cancelled' | 'completed';

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

const STANDALONE_TOOL_BLOCKS = new Set([
  'TodoWrite',
  'Task',
  'update_plan',
  'request_user_input',
  'AskUserQuestion',
  'proposed_plan',
  'create_goal',
  'update_goal',
  'get_goal'
]);

function shouldRenderToolAsStandalone(name: string) {
  return STANDALONE_TOOL_BLOCKS.has(String(name || '').trim());
}

export function decodeMessageStructureEntities(value: string) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function isolateStructuredXmlTags(content: string) {
  const raw = String(content || '');
  const tagNames = [
    'oai-mem-citation',
    'task-notification',
    'proposed_plan',
    'thinking',
    'request_user_input',
    'AskUserQuestion',
    'answers',
    'answer'
  ];
  const tagPattern = tagNames.join('|');
  const escapedPattern = new RegExp(`(^|\\n)[\\t ]*&lt;(${tagPattern})(?:\\s+[^&]*?)?&gt;[\\s\\S]*?&lt;\\/\\2&gt;(?=[\\t ]*(?:\\n|$))`, 'gi');
  const plainPattern = new RegExp(`(^|\\n)[\\t ]*<(${tagPattern})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\2>(?=[\\t ]*(?:\\n|$))`, 'gi');
  const doubleEscapedPattern = new RegExp(`(^|\\n)[\\t ]*&amp;lt;(${tagPattern})(?:\\s+[^&]*?)?&amp;gt;[\\s\\S]*?&amp;lt;\\/\\2&amp;gt;(?=[\\t ]*(?:\\n|$))`, 'gi');

  // 只解码独立行上的结构化 XML 块，避免正文里提到标签名时跨段误吞后续引用块。
  return raw
    .replace(doubleEscapedPattern, (match, prefix) => `${prefix}\n${decodeMessageStructureEntities(decodeMessageStructureEntities(match.slice(String(prefix || '').length)))}\n`)
    .replace(escapedPattern, (match, prefix) => `${prefix}\n${decodeMessageStructureEntities(match.slice(String(prefix || '').length))}\n`)
    .replace(plainPattern, (match, prefix) => `${prefix}\n${match.slice(String(prefix || '').length)}\n`);
}

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
      if (shouldRenderToolAsStandalone(block.name)) {
        flushTools();
        merged.push(block);
        continue;
      }
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
  const lines = isolateStructuredXmlTags(String(content || '')).split('\n');
  let index = 0;
  let textBuffer: string[] = [];
  let inCodeBlock = false;

  const flushText = () => {
    const text = textBuffer.join('\n').trim();
    if (text) blocks.push({ type: 'text', value: text });
    textBuffer = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    let parsedByPlugin = false;
    for (const parser of registeredParsers) {
      const result = parser.parse({ lines, index, inCodeBlock });
      if (result) {
        if (result.block || result.consumed > 0) {
          flushText();
        }
        if (result.block) {
          blocks.push(result.block);
        }
        index += result.consumed;
        parsedByPlugin = true;
        break;
      }
    }

    if (parsedByPlugin) continue;

    textBuffer.push(line);
    index += 1;
  }

  flushText();
  if (blocks.length === 0) {
    blocks.push({ type: 'text', value: String(content || '') });
  }
  return mergeAdjacentToolBlocks(blocks);
}

// 不同 provider 的计划状态命名不完全一致，解析层统一成 UI 可稳定消费的状态机。
const TASK_STATUS_LABELS: Record<StructuredTaskStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过'
};

const OPEN_TASK_STATUSES = new Set<StructuredTaskStatus>(['pending', 'in_progress', 'blocked']);

export function normalizeTaskStatus(status: string): StructuredTaskStatus {
  const raw = String(status || '').trim().toLowerCase();
  if (raw === 'completed' || raw === 'complete' || raw === 'done' || raw === 'success' || raw === 'succeeded') return 'completed';
  if (raw === 'in_progress' || raw === 'in-progress' || raw === 'active' || raw === 'running' || raw === 'current') {
    return 'in_progress';
  }
  if (raw === 'blocked' || raw === 'stuck' || raw === 'waiting_on_user' || raw === 'waiting-on-user') return 'blocked';
  if (raw === 'failed' || raw === 'failure' || raw === 'error' || raw === 'errored') return 'failed';
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'aborted' || raw === 'interrupted') return 'cancelled';
  if (raw === 'skipped' || raw === 'skip' || raw === 'ignored') return 'skipped';
  return 'pending';
}

export function getTaskStatusLabel(status: StructuredTaskStatus) {
  return TASK_STATUS_LABELS[status] || TASK_STATUS_LABELS.pending;
}

// TodoWrite 与 update_plan 的参数形态不同，统一读取数组入口，避免组件层知道协议细节。
function readStructuredItems(parsed: any) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.todos)) return parsed.todos;
  if (Array.isArray(parsed?.tasks)) return parsed.tasks;
  if (Array.isArray(parsed?.plan)) return parsed.plan;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.plan?.items)) return parsed.plan.items;
  return null;
}

function normalizeStructuredTaskItem(item: any): StructuredTaskItem | null {
  if (!item || typeof item !== 'object') return null;
  const content = String(item.content || item.step || item.title || item.task || item.text || '').trim();
  if (!content) return null;
  return {
    content,
    status: normalizeTaskStatus(String(item.status || 'pending'))
  };
}

export function parseTodoItems(body: string): StructuredTaskItem[] | null {
  try {
    const parsed = JSON.parse(body);
    const sourceItems = readStructuredItems(parsed);
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) return null;
    const items = sourceItems
      .map(normalizeStructuredTaskItem)
      .filter((item): item is StructuredTaskItem => Boolean(item));
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

export function parsePlanItems(body: string): { explanation: string; items: StructuredTaskItem[] } | null {
  try {
    const parsed = JSON.parse(body);
    const sourceItems = readStructuredItems(parsed);
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) return null;

    const items = sourceItems
      .map(normalizeStructuredTaskItem)
      .filter((item): item is StructuredTaskItem => Boolean(item));

    if (items.length === 0) return null;
    return {
      explanation: String(parsed?.explanation || parsed?.summary || parsed?.plan?.explanation || '').trim(),
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
        title: '待办',
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
        title: '计划',
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
  const runningCount = items.filter((item) => item.status === 'in_progress').length;
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const blockedCount = items.filter((item) => item.status === 'blocked').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const cancelledCount = items.filter((item) => item.status === 'cancelled').length;
  const skippedCount = items.filter((item) => item.status === 'skipped').length;
  const activeCount = items.filter((item) => OPEN_TASK_STATUSES.has(item.status)).length;
  return {
    totalCount,
    completedCount,
    runningCount,
    pendingCount,
    blockedCount,
    failedCount,
    cancelledCount,
    skippedCount,
    activeCount
  };
}

export function getChecklistState(items: StructuredTaskItem[]): ChecklistState {
  const progress = countChecklistProgress(items);
  if (progress.failedCount > 0) return 'failed';
  if (progress.cancelledCount > 0) return 'cancelled';
  if (progress.blockedCount > 0) return 'attention';
  if (progress.runningCount > 0) return 'running';
  if (progress.totalCount > 0 && progress.completedCount + progress.skippedCount === progress.totalCount) return 'completed';
  return 'waiting';
}

export function getChecklistStateLabel(state: ChecklistState) {
  if (state === 'completed') return '已完成';
  if (state === 'running') return '进行中';
  if (state === 'attention') return '需处理';
  if (state === 'failed') return '失败';
  if (state === 'cancelled') return '已取消';
  return '待开始';
}

export function isChecklistOpen(items: StructuredTaskItem[]) {
  const state = getChecklistState(items);
  return state === 'waiting' || state === 'running' || state === 'attention';
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
      return isChecklistOpen(checklist.items) ? checklist : null;
    }
  }
  return null;
}
