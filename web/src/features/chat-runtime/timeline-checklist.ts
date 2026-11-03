import type { SessionProjection, TimelineItem } from '@/chat-runtime';
import {
  isChecklistOpen,
  normalizeTaskStatus,
  parseStructuredChecklist,
  type StructuredChecklist,
} from '@/components/chat/message-structure';

// 任务清单停靠卡（由 legacy MessageArea 的 TaskDock 迁入 canonical）：
// 时间线里最近一份「计划 / 待办」若仍有未完成项，就钉在输入框上方，长会话里不用往回翻。
// 来源两种，同一种卡片：
//   - plan 条目（codex update_plan 等，结构化 steps）；
//   - 工具条目里的 TodoWrite / update_plan / Task 调用（claude、opencode 等，复用 legacy 的解析适配器）。
// 最近一份已全部完成 → 不显示（与 legacy 同语义：完成即收起）。

function fromPlanItem(item: Extract<TimelineItem, { kind: 'plan' }>): StructuredChecklist | null {
  const steps = item.detail.steps || [];
  if (steps.length === 0) return null;
  return {
    kind: 'plan',
    sourceTool: 'update_plan',
    title: '计划',
    explanation: item.content || '',
    items: steps.map((step) => ({ content: step.step, status: normalizeTaskStatus(step.status) })),
  };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function fromToolItem(item: Extract<TimelineItem, { kind: 'tool' }>): StructuredChecklist | null {
  return parseStructuredChecklist(item.detail.name, stringify(item.detail.input), stringify(item.detail.result) || undefined);
}

export function findActiveTimelineChecklist(items: readonly TimelineItem[]): StructuredChecklist | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const checklist = item.kind === 'plan' ? fromPlanItem(item)
      : item.kind === 'tool' ? fromToolItem(item)
        : null;
    if (!checklist) continue;
    return isChecklistOpen(checklist.items) ? checklist : null;
  }
  return null;
}

export function selectActiveChecklist(projection: SessionProjection): StructuredChecklist | null {
  return findActiveTimelineChecklist(projection.items);
}

// 选择器等价判断：清单内容不变就复用旧值，流式输出的每帧发布不会让停靠卡重渲染。
export function sameChecklist(a: StructuredChecklist | null, b: StructuredChecklist | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.explanation === b.explanation
    && a.items.length === b.items.length
    && a.items.every((item, index) => item.content === b.items[index].content && item.status === b.items[index].status);
}
