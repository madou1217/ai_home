import {
  nonNegativeInteger,
  optionalText,
  protocolFailure,
  record,
  text,
} from './dto-guards';
import {
  parseApprovalDetail,
  parseArtifactDetail,
  parseAttachmentDetail,
  parseCommandDetail,
  parseDiffDetail,
  parseErrorDetail,
  parseFileChangeDetail,
  parseMessageDetail,
  parseNoticeDetail,
  parsePlanDetail,
  parseQuestionDetail,
  parseReasoningDetail,
  parseShellDetail,
  parseSubagentDetail,
  parseTerminalDetail,
  parseToolDetail,
} from './timeline-detail-parser';
import type { TimelineItem, TimelineItemStatus } from './types';

const ITEM_STATUSES = new Set<TimelineItemStatus>([
  'pending', 'running', 'waiting_input', 'completed', 'failed', 'cancelled',
]);
const DETAIL_PARSERS: Readonly<Record<TimelineItem['kind'], (value: unknown) => unknown>> = {
  message: parseMessageDetail,
  reasoning: parseReasoningDetail,
  plan: parsePlanDetail,
  tool: parseToolDetail,
  shell: parseShellDetail,
  diff: parseDiffDetail,
  file_change: parseFileChangeDetail,
  terminal: parseTerminalDetail,
  question: parseQuestionDetail,
  approval: parseApprovalDetail,
  subagent: parseSubagentDetail,
  command: parseCommandDetail,
  attachment: parseAttachmentDetail,
  artifact: parseArtifactDetail,
  notice: parseNoticeDetail,
  error: parseErrorDetail,
};

export function parseTimelineItem(value: unknown): TimelineItem {
  const source = record(value, 'chat_runtime_timeline_item_invalid');
  const base = parseBase(source);
  const kind = parseKind(source.kind);
  return { ...base, kind, detail: DETAIL_PARSERS[kind](source.detail) } as TimelineItem;
}

function parseKind(value: unknown): TimelineItem['kind'] {
  const kind = text(value, 'chat_runtime_timeline_kind_invalid') as TimelineItem['kind'];
  if (!Object.prototype.hasOwnProperty.call(DETAIL_PARSERS, kind)) {
    return protocolFailure('chat_runtime_timeline_kind_invalid');
  }
  return kind;
}

function parseBase(source: Record<string, unknown>) {
  return {
    id: text(source.id, 'chat_runtime_timeline_id_invalid'),
    createdAt: nonNegativeInteger(source.createdAt, 'chat_runtime_timeline_created_at_invalid'),
    status: parseStatus(source.status),
    ...optionalIdentity(source, 'turnId', 'chat_runtime_timeline_turn_id_invalid'),
    ...optionalTimestamp(source, 'updatedAt'),
    ...optionalContent(source.content),
  };
}

function parseStatus(value: unknown): TimelineItemStatus {
  const status = text(value, 'chat_runtime_timeline_status_invalid') as TimelineItemStatus;
  if (!ITEM_STATUSES.has(status)) protocolFailure('chat_runtime_timeline_status_invalid');
  return status;
}

function optionalIdentity(source: Record<string, unknown>, field: string, code: string) {
  const value = optionalText(source[field], code);
  return value === undefined ? {} : { [field]: value };
}

function optionalTimestamp(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : {
    [field]: nonNegativeInteger(source[field], 'chat_runtime_timeline_updated_at_invalid'),
  };
}

function optionalContent(value: unknown) {
  if (value === undefined) return {};
  if (typeof value !== 'string') protocolFailure('chat_runtime_timeline_content_invalid');
  return { content: value };
}
