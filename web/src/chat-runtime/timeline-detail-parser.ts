import {
  booleanValue,
  nonNegativeInteger,
  protocolFailure,
  record,
  text,
} from './dto-guards';
import type { TimelineDetailByKind } from './timeline-details';

const ROLES = new Set(['user', 'assistant', 'system'] as const);
const STREAMS = new Set(['stdin', 'stdout', 'stderr'] as const);
const DECISIONS = new Set(['allow', 'deny'] as const);
const NOTICE_LEVELS = new Set(['info', 'warning', 'success'] as const);

export function parseMessageDetail(value: unknown): TimelineDetailByKind['message'] {
  const source = detail(value);
  return {
    role: choice(source.role, ROLES, 'role'),
    ...optionalText(source, 'phase'),
    ...optionalText(source, 'model'),
  };
}

export function parseReasoningDetail(value: unknown): TimelineDetailByKind['reasoning'] {
  const source = detail(value);
  return { ...optionalString(source, 'summary'), ...optionalStrings(source, 'segments') };
}

export { parsePlanDetail } from './plan-detail-parser';

export function parseToolDetail(value: unknown): TimelineDetailByKind['tool'] {
  const source = detail(value);
  return {
    name: required(source, 'name'),
    ...optionalText(source, 'callId'), ...optionalUnknown(source, 'input'),
    ...optionalUnknown(source, 'result'), ...optionalInteger(source, 'exitCode'),
    ...optionalText(source, 'server'),
  };
}

export function parseShellDetail(value: unknown): TimelineDetailByKind['shell'] {
  const source = detail(value);
  return {
    command: required(source, 'command'),
    ...optionalText(source, 'cwd'), ...optionalText(source, 'callId'),
    ...optionalString(source, 'output'), ...optionalInteger(source, 'exitCode'),
    ...optionalNonNegativeInteger(source, 'processId'), ...optionalArray(source, 'actions'),
  };
}

export function parseDiffDetail(value: unknown): TimelineDetailByKind['diff'] {
  const source = detail(value);
  return { ...optionalStrings(source, 'paths'), ...optionalString(source, 'patch') };
}

export function parseFileChangeDetail(value: unknown): TimelineDetailByKind['file_change'] {
  const source = detail(value);
  return {
    ...optionalText(source, 'callId'),
    changes: array(source.changes, 'changes'),
    ...optionalString(source, 'diff'),
  };
}

export function parseTerminalDetail(value: unknown): TimelineDetailByKind['terminal'] {
  const source = detail(value);
  return {
    stream: choice(source.stream, STREAMS, 'stream'),
    ...optionalText(source, 'terminalId'), ...optionalText(source, 'artifactId'),
  };
}

export function parseQuestionDetail(value: unknown): TimelineDetailByKind['question'] {
  const source = detail(value);
  return {
    interactionId: required(source, 'interactionId'),
    ...optionalStrings(source, 'options'), ...optionalBoolean(source, 'answered'),
  };
}

export function parseApprovalDetail(value: unknown): TimelineDetailByKind['approval'] {
  const source = detail(value);
  return {
    interactionId: required(source, 'interactionId'), action: required(source, 'action'),
    ...optionalChoice(source, 'decision', DECISIONS),
  };
}

export function parseSubagentDetail(value: unknown): TimelineDetailByKind['subagent'] {
  const source = detail(value);
  return { agentId: required(source, 'agentId'), ...optionalText(source, 'state') };
}

export function parseCommandDetail(value: unknown): TimelineDetailByKind['command'] {
  const source = detail(value);
  return { commandId: required(source, 'commandId'), command: required(source, 'command') };
}

export function parseAttachmentDetail(value: unknown): TimelineDetailByKind['attachment'] {
  const source = detail(value);
  return {
    name: required(source, 'name'), mimeType: required(source, 'mimeType'),
    ...optionalText(source, 'url'),
  };
}

export function parseArtifactDetail(value: unknown): TimelineDetailByKind['artifact'] {
  const source = detail(value);
  return {
    artifactId: required(source, 'artifactId'), name: required(source, 'name'),
    mimeType: required(source, 'mimeType'), ...optionalNonNegativeInteger(source, 'size'),
  };
}

export function parseNoticeDetail(value: unknown): TimelineDetailByKind['notice'] {
  const source = detail(value);
  return { level: choice(source.level, NOTICE_LEVELS, 'level') };
}

export function parseErrorDetail(value: unknown): TimelineDetailByKind['error'] {
  const source = detail(value);
  return { code: required(source, 'code'), ...optionalBoolean(source, 'retryable') };
}

function detail(value: unknown): Record<string, unknown> {
  return record(value, 'chat_runtime_timeline_detail_invalid');
}

function code(field: string): string {
  return `chat_runtime_timeline_detail_${field}_invalid`;
}

function required(source: Record<string, unknown>, field: string): string {
  return text(source[field], code(field));
}

function choice<const T extends string>(value: unknown, values: ReadonlySet<T>, field: string): T {
  const result = text(value, code(field)) as T;
  if (!values.has(result)) protocolFailure(code(field));
  return result;
}

function optionalChoice<const T extends string>(
  source: Record<string, unknown>, field: string, values: ReadonlySet<T>,
): Partial<Record<typeof field, T>> {
  return source[field] === undefined ? {} : { [field]: choice(source[field], values, field) };
}

function optionalText(source: Record<string, unknown>, field: string): Partial<Record<string, string>> {
  return source[field] === undefined ? {} : { [field]: required(source, field) };
}

function optionalString(source: Record<string, unknown>, field: string): Partial<Record<string, string>> {
  const value = source[field];
  if (value === undefined) return {};
  if (typeof value !== 'string') protocolFailure(code(field));
  return { [field]: value };
}

function optionalStrings(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: strings(source[field], field) };
}

function strings(value: unknown, field: string): readonly string[] {
  return array(value, field).map((entry) => text(entry, code(field)));
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) protocolFailure(code(field));
  return value;
}

function optionalArray(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: array(source[field], field) };
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) protocolFailure(code(field));
  return Number(value);
}

function optionalInteger(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: integer(source[field], field) };
}

function optionalNonNegativeInteger(source: Record<string, unknown>, field: string) {
  return source[field] === undefined
    ? {} : { [field]: nonNegativeInteger(source[field], code(field)) };
}

function optionalBoolean(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: booleanValue(source[field], code(field)) };
}

function optionalUnknown(source: Record<string, unknown>, field: string) {
  return source[field] === undefined ? {} : { [field]: source[field] };
}
