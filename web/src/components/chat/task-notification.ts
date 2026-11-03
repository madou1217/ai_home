import type { StatusTone } from './EventBlock';

export type TaskNotification = {
  taskId: string;
  toolUseId: string;
  outputFile: string;
  status: string;
  summary: string;
};

export type TaskNotificationStatus = {
  label: string;
  tone: StatusTone;
  dot: boolean;
};

const TASK_STATUS_TONES = new Map<string, StatusTone>([
  ['success', 'success'],
  ['completed', 'success'],
  ['ok', 'success'],
  ['created', 'running'],
  ['queued', 'running'],
  ['pending', 'running'],
  ['running', 'running'],
  ['in_progress', 'running'],
  ['blocked', 'attention'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['deleted', 'cancelled'],
  ['skipped', 'cancelled'],
  ['failed', 'failed'],
  ['error', 'failed']
]);

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function extractXmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : '';
}

function parseJsonNotification(raw: string): TaskNotification | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = parsed as Record<string, unknown>;
    return {
      taskId: normalizeText(source.taskId ?? source.task_id ?? source['task-id']),
      toolUseId: normalizeText(source.toolUseId ?? source.tool_use_id ?? source['tool-use-id']),
      outputFile: normalizeText(source.outputFile ?? source.output_file ?? source['output-file']),
      status: normalizeText(source.status),
      summary: normalizeText(source.summary)
    };
  } catch (_error) {
    return null;
  }
}

export function parseTaskNotification(value: string): TaskNotification {
  const raw = normalizeText(value);
  const jsonNotification = parseJsonNotification(raw);
  if (jsonNotification) return jsonNotification;

  const taskId = extractXmlTag(raw, 'task-id');
  const status = extractXmlTag(raw, 'status');
  if (taskId || status || raw.includes('<summary>')) {
    return {
      taskId,
      toolUseId: extractXmlTag(raw, 'tool-use-id'),
      outputFile: extractXmlTag(raw, 'output-file'),
      status,
      summary: extractXmlTag(raw, 'summary')
    };
  }

  return { taskId: '', toolUseId: '', outputFile: '', status: '', summary: raw };
}

export function getTaskNotificationStatus(status: string): TaskNotificationStatus {
  const label = normalizeText(status) || 'unknown';
  const tone = TASK_STATUS_TONES.get(label.toLowerCase()) || 'neutral';
  return { label, tone, dot: tone === 'running' };
}
