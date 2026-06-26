// =============================================================================
// Canonical ProviderBlock —— 归一渲染契约（前端适配层）
// -----------------------------------------------------------------------------
// 目标（见 tmp/provider-native-session-structure-comparison.md）：
//   渲染器只消费 canonical block，不再认 provider 私有名
//   （TodoWrite / update_plan / proposed_plan / thoughts / AskUserQuestion …）。
//
// 本模块是【唯一】知道这些私有名的地方：把 message-structure 产出的中间
// MessageBlock[] 分类成 ProviderBlock[]，渲染器据 `kind` 一一映射到叶子组件。
// 纯逻辑、无 React，便于单测与后续替换为后端直出 block。
// =============================================================================
import type { MessageBlock, ToolItem, StructuredChecklist } from './message-structure';
import { parseStructuredChecklist } from './message-structure';
import { parseUserAnswers } from './UserAnswersBlock';

export type ProviderBlock =
  | { kind: 'text'; value: string }
  | { kind: 'reasoning'; value: string }
  | { kind: 'checklist'; checklist: StructuredChecklist }
  | { kind: 'plan_text'; value: string }
  | { kind: 'question'; body: string; result?: string }
  | { kind: 'answers'; value: string }
  | { kind: 'goal'; context?: string; body?: string; result?: string }
  | { kind: 'memory_citation'; value: string }
  | { kind: 'task_event'; value: string }
  | { kind: 'shell'; name: string; body: string; result?: string }
  | { kind: 'tool'; name: string; body: string; result?: string }
  | { kind: 'tool_group'; items: ToolItem[] }
  | { kind: 'generic_tag'; name: string; value: string; orphanClose?: boolean };

const GOAL_TOOL_NAMES = new Set(['create_goal', 'update_goal', 'get_goal']);
const QUESTION_TOOL_NAMES = new Set(['request_user_input', 'AskUserQuestion']);
const SHELL_TOOL_NAMES = new Set(['Bash', 'Terminal', 'Git']);

// goal_context 与 codex_internal_context 是同一类目标上下文，分发时不关心来源 tag。
export function isGoalContextTag(name: string, value: string) {
  const tagName = String(name || '').trim();
  return (tagName === 'codex_internal_context' || tagName === 'goal_context')
    && String(value || '').includes('<objective>');
}

function classifyTag(name: string, value: string, orphanClose?: boolean): ProviderBlock {
  const n = String(name || '').trim();
  // 保持与旧 TagBlock 完全一致的判定顺序，避免任何渲染回归。
  if (n === 'proposed_plan') return { kind: 'plan_text', value };
  if (n === 'thinking') return { kind: 'reasoning', value };
  if ((n === 'answers' || n === 'answer') && parseUserAnswers(value)) return { kind: 'answers', value };
  if (QUESTION_TOOL_NAMES.has(n)) return { kind: 'question', body: value };
  if (orphanClose) return { kind: 'generic_tag', name: n, value: '', orphanClose: true };
  if (n === 'oai-mem-citation') return { kind: 'memory_citation', value };
  if (n === 'task-notification') return { kind: 'task_event', value };
  if (isGoalContextTag(n, value)) return { kind: 'goal', context: value };
  return { kind: 'generic_tag', name: n, value };
}

function classifyTool(name: string, body: string, result?: string): ProviderBlock {
  const n = String(name || '').trim();
  // 结构化 checklist（TodoWrite / update_plan / Task）优先；解析失败回退普通工具。
  const checklist = parseStructuredChecklist(n, body, result);
  if (checklist) return { kind: 'checklist', checklist };
  if (GOAL_TOOL_NAMES.has(n)) return { kind: 'goal', body, result };
  if (n === 'proposed_plan') return { kind: 'plan_text', value: body };
  if (QUESTION_TOOL_NAMES.has(n)) return { kind: 'question', body, result };
  if (
    (n === 'answers' || n === 'answer' || (body.includes('"answers"') && (n === 'UserResponse' || n === 'SubmitAnswers')))
    && parseUserAnswers(body)
  ) {
    return { kind: 'answers', value: body };
  }
  if (SHELL_TOOL_NAMES.has(n) && body) return { kind: 'shell', name: n, body, result };
  return { kind: 'tool', name: n, body, result };
}

/** 把中间 MessageBlock[] 归一成 canonical ProviderBlock[]。 */
export function toProviderBlocks(blocks: MessageBlock[]): ProviderBlock[] {
  const out: ProviderBlock[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ kind: 'text', value: block.value });
        break;
      case 'thinking':
        out.push({ kind: 'reasoning', value: block.value });
        break;
      case 'tool_use':
        out.push(classifyTool(block.name, block.body, block.result));
        break;
      case 'tool_group':
        out.push({ kind: 'tool_group', items: block.items });
        break;
      case 'tag':
        out.push(classifyTag(block.name, block.value, block.orphanClose));
        break;
    }
  }
  return out;
}
