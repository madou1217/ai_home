'use strict';

const ITEM_KINDS = new Map([
  ['userMessage', 'message'], ['agentMessage', 'message'], ['reasoning', 'reasoning'],
  ['plan', 'plan'], ['commandExecution', 'shell'], ['fileChange', 'file_change'],
  ['mcpToolCall', 'tool'], ['dynamicToolCall', 'tool'], ['webSearch', 'tool'],
  ['imageView', 'tool'], ['sleep', 'tool'], ['imageGeneration', 'tool'],
  ['collabAgentToolCall', 'subagent'], ['subAgentActivity', 'subagent'],
  ['hookPrompt', 'notice'], ['enteredReviewMode', 'notice'],
  ['exitedReviewMode', 'notice'], ['contextCompaction', 'notice'], ['error', 'error']
]);

const DETAIL_BUILDERS = new Map([
  ['message', messageDetail], ['reasoning', reasoningDetail], ['plan', planDetail],
  ['shell', shellDetail], ['file_change', fileChangeDetail], ['tool', toolDetail],
  ['subagent', subagentDetail], ['notice', noticeDetail], ['error', errorDetail]
]);

const CONTENT_BUILDERS = new Map([
  ['message', messageContent], ['plan', textContent], ['reasoning', reasoningContent],
  ['shell', shellContent], ['file_change', fileChangeContent], ['notice', noticeContent],
  ['error', errorContent]
]);

const USER_INPUT_PROJECTORS = new Map([
  ['text', projectTextInput], ['image', projectImageInput],
  ['localImage', projectImageInput], ['skill', projectSkillInput],
  ['mention', projectMentionInput]
]);

function buildCodexTimelineItem(item, params, completed) {
  const kind = ITEM_KINDS.get(item.type) || 'error';
  const at = timestamp(completed ? params.completedAtMs : params.startedAtMs);
  const userMessage = projectUserMessage(item.type === 'userMessage' ? item.content : []);
  const result = {
    id: String(item.id),
    kind,
    createdAt: at,
    status: kind === 'error' ? 'failed' : itemStatus(item.status, completed),
    detail: itemDetail(item, kind, completed, userMessage, params)
  };
  const content = itemContent(item, kind, userMessage);
  if (content !== undefined) result.content = content;
  if (completed) result.updatedAt = at;
  return result;
}

function itemDetail(item, kind, completed, userMessage, params) {
  const builder = DETAIL_BUILDERS.get(kind) || errorDetail;
  return builder(item, completed, userMessage, params);
}

function messageDetail(item, _completed, userMessage, params = {}) {
  return compact({
    role: item.type === 'userMessage' ? 'user' : 'assistant',
    phase: item.phase,
    model: params.model,
    inputs: userMessage.inputs.length > 0 ? userMessage.inputs : undefined
  });
}

function reasoningDetail(item) {
  return compact({ summary: joinedText(item.summary), segments: textSegments(item.content) });
}

function planDetail(item, completed) {
  return compact({ state: completed ? 'proposed' : 'draft', steps: planSteps(item.steps) });
}

function shellDetail(item) {
  return compact({
    callId: item.id, command: String(item.command || ''), cwd: item.cwd,
    output: item.aggregatedOutput ?? item.output,
    exitCode: item.exitCode ?? undefined,
    processId: item.processId ?? undefined,
    actions: clone(item.commandActions)
  });
}

function toolDetail(item) {
  return compact({
    callId: item.callId || item.id, name: item.tool || item.type, server: item.server,
    input: clone(item.arguments ?? item.input ?? item.query ?? item.path),
    result: clone(item.result ?? item.contentItems ?? item.error ?? null),
    exitCode: item.exitCode ?? undefined
  });
}

function subagentDetail(item) {
  return compact({ agentId: item.agentId || item.id, state: item.status });
}

function noticeDetail(item) { return { level: 'info', code: item.type }; }

function errorDetail(item) { return { code: item.code || 'codex_item_error', retryable: false }; }

function fileChangeDetail(item) {
  const changes = Array.isArray(item.changes) ? clone(item.changes) : [];
  return {
    callId: item.id,
    changes,
    diff: fileChangeDiff(changes)
  };
}

function itemContent(item, kind, userMessage) {
  const builder = CONTENT_BUILDERS.get(kind);
  return builder ? builder(item, userMessage) : undefined;
}

function messageContent(item, userMessage) {
  return item.type === 'userMessage' ? userMessage.content : textContent(item);
}

function textContent(item) {
  return String(item.text || '');
}

function reasoningContent(item) {
  return [...(item.summary || []), ...(item.content || [])].join('\n');
}

function shellContent(item) {
  return typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined;
}

function fileChangeContent(item) {
  return fileChangeDiff(Array.isArray(item.changes) ? item.changes : []);
}

function fileChangeDiff(changes) {
  return changes.map((change) => change.diff || '').filter(Boolean).join('\n');
}

function errorContent(item) {
  return String(item.message || 'unknown_codex_item_type');
}

function noticeContent(item) {
  if (item.type === 'contextCompaction') return 'Context compacted';
  return String(item.message || item.text || '');
}

function projectUserMessage(value) {
  const projection = { texts: [], inputs: [] };
  for (const input of (Array.isArray(value) ? value : [])) {
    const projector = input && USER_INPUT_PROJECTORS.get(input.type);
    if (!projector) continue;
    const part = projector(input);
    if (part.text) projection.texts.push(part.text);
    if (part.input) projection.inputs.push(part.input);
  }
  return { content: projection.texts.join('\n'), inputs: projection.inputs };
}

function projectTextInput(input) {
  return typeof input.text === 'string' && input.text ? { text: input.text } : {};
}

function projectImageInput() {
  return { input: { kind: 'image' } };
}

function projectSkillInput(input) { return projectNamedInput('skill', input); }

function projectMentionInput(input) { return projectNamedInput('mention', input); }

function projectNamedInput(kind, input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  return name ? { input: { kind, name } } : {};
}

function itemStatus(status, completed) {
  return ({ inProgress: 'running', completed: 'completed', failed: 'failed', declined: 'cancelled' })[status]
    || (completed ? 'completed' : 'running');
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function joinedText(value) {
  const segments = textSegments(value);
  return segments && segments.length > 0 ? segments.join('\n') : undefined;
}

function textSegments(value) {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => String(entry && entry.text || entry || '')).filter(Boolean);
}

function planSteps(value) {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry && (entry.step || entry.text) || entry || '')).filter(Boolean);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

module.exports = { buildCodexTimelineItem };
