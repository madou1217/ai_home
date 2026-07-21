import {
  assertSessionId,
  booleanValue,
  nonNegativeInteger,
  protocolFailure,
  record,
  records,
  sessionState,
  text,
} from './dto-guards';
import { parseCapabilitySnapshot } from './capability-parser';
import { parseSessionSnapshot, parseTimelineItem } from './snapshot-parser';
import type {
  ChatRuntimeCommandResult,
  ChatRuntimeAttachment,
  ChatRuntimeSession,
  ComposerCatalog,
  CommandCatalogEntry,
  ResolveSessionInput,
  SessionResolution,
  TimelinePage,
} from './api-types';
import type { SessionSnapshot } from './types';

export function parseCreatedSession(value: unknown): ChatRuntimeSession {
  const response = record(value, 'chat_runtime_response_invalid');
  return parseSession(record(response.session, 'chat_runtime_session_invalid'));
}

export function parseSessionList(value: unknown): readonly ChatRuntimeSession[] {
  const response = record(value, 'chat_runtime_response_invalid');
  return records(response.sessions, 'chat_runtime_sessions_invalid').map(parseSession);
}

export function parseSessionResolution(
  value: unknown,
  expected: ResolveSessionInput,
): SessionResolution {
  const response = record(value, 'chat_runtime_response_invalid');
  const status = text(response.status, 'chat_runtime_session_resolution_status_invalid');
  if (status !== 'created' && status !== 'adopted') {
    protocolFailure('chat_runtime_session_resolution_status_invalid');
  }
  const session = parseSession(record(response.session, 'chat_runtime_session_invalid'));
  assertResolutionIdentity(session, expected);
  return { status, session };
}

export function parseSnapshotResponse(value: unknown, sessionId: string): SessionSnapshot {
  const response = record(value, 'chat_runtime_response_invalid');
  return parseSessionSnapshot(response.snapshot, sessionId);
}

export function parseTimelineResponse(value: unknown, sessionId: string): TimelinePage {
  const response = record(value, 'chat_runtime_response_invalid');
  const source = record(response.timeline, 'chat_runtime_timeline_invalid');
  const nextBefore = source.nextBefore;
  if (nextBefore !== null && typeof nextBefore !== 'string') {
    protocolFailure('chat_runtime_timeline_cursor_invalid');
  }
  return {
    sessionId: assertSessionId(source.sessionId, sessionId),
    items: records(source.items, 'chat_runtime_timeline_items_invalid').map(parseTimelineItem),
    hasMore: booleanValue(source.hasMore, 'chat_runtime_timeline_has_more_invalid'),
    nextBefore,
    throughSeq: nonNegativeInteger(source.throughSeq, 'chat_runtime_timeline_seq_invalid'),
  };
}

export function parseCommandResponse(
  value: unknown,
  sessionId: string,
  commandId: string,
): ChatRuntimeCommandResult {
  const source = record(value, 'chat_runtime_command_response_invalid');
  assertSessionId(source.sessionId, sessionId);
  if (text(source.commandId, 'chat_runtime_command_id_invalid') !== commandId) {
    protocolFailure('chat_runtime_command_mismatch');
  }
  return {
    sessionId,
    commandId,
    acceptedSeq: nonNegativeInteger(source.acceptedSeq, 'chat_runtime_command_seq_invalid'),
    duplicate: booleanValue(source.duplicate, 'chat_runtime_command_duplicate_invalid'),
    ...(source.result === undefined ? {} : { result: source.result }),
  };
}

export function parseCommandCatalog(value: unknown): readonly CommandCatalogEntry[] {
  const response = record(value, 'chat_runtime_response_invalid');
  return records(response.commands, 'chat_runtime_command_catalog_invalid').map((entry) => {
    const identity = entry.type ?? entry.id;
    text(identity, 'chat_runtime_command_catalog_entry_invalid');
    return entry;
  });
}

export function parseComposerCatalog(value: unknown): ComposerCatalog {
  const response = record(value, 'chat_runtime_response_invalid');
  const source = record(response.catalog, 'chat_runtime_composer_catalog_invalid');
  const models = records(source.models, 'chat_runtime_composer_models_invalid').map((entry) => {
    const id = text(entry.id, 'chat_runtime_composer_model_id_invalid');
    const supportedEfforts = uniqueTexts(
      entry.supportedEfforts,
      'chat_runtime_composer_model_efforts_invalid',
    );
    const defaultEffort = text(
      entry.defaultEffort,
      'chat_runtime_composer_model_default_effort_invalid',
    );
    if (supportedEfforts.length > 0 && !supportedEfforts.includes(defaultEffort)) {
      protocolFailure('chat_runtime_composer_model_default_effort_invalid');
    }
    return {
      id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : id,
      supportedEfforts,
      defaultEffort,
    };
  });
  const defaultModel = text(source.defaultModel, 'chat_runtime_composer_default_model_invalid');
  if (!models.some((model) => model.id === defaultModel)) {
    protocolFailure('chat_runtime_composer_default_model_invalid');
  }
  return { models, defaultModel };
}

export function parseAttachmentResponse(
  value: unknown,
  sessionId: string,
): readonly ChatRuntimeAttachment[] {
  const response = record(value, 'chat_runtime_response_invalid');
  assertSessionId(response.sessionId, sessionId);
  return records(response.attachments, 'chat_runtime_attachments_invalid').map((source) => ({
    attachmentId: text(source.attachmentId, 'chat_runtime_attachment_id_invalid'),
    sessionId: assertSessionId(source.sessionId, sessionId),
    name: text(source.name, 'chat_runtime_attachment_name_invalid'),
    mimeType: text(source.mimeType, 'chat_runtime_attachment_mime_invalid'),
    createdAt: nonNegativeInteger(source.createdAt, 'chat_runtime_attachment_created_at_invalid'),
  }));
}

function uniqueTexts(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value)) protocolFailure(code);
  const normalized = value.map((item) => text(item, code).trim().toLowerCase());
  return [...new Set(normalized)];
}

function parseSession(source: Record<string, unknown>): ChatRuntimeSession {
  return {
    sessionId: text(source.sessionId, 'chat_runtime_session_id_invalid'),
    provider: text(source.provider, 'chat_runtime_session_provider_invalid'),
    executionAccountRef: text(
      source.executionAccountRef,
      'chat_runtime_session_execution_account_invalid',
    ),
    projectPath: typeof source.projectPath === 'string' ? source.projectPath : '',
    state: sessionState(source.state),
    lastEventSeq: nonNegativeInteger(source.lastEventSeq, 'chat_runtime_session_seq_invalid'),
    createdAt: nonNegativeInteger(source.createdAt, 'chat_runtime_session_created_at_invalid'),
    updatedAt: nonNegativeInteger(source.updatedAt, 'chat_runtime_session_updated_at_invalid'),
    policy: record(source.policy, 'chat_runtime_session_policy_invalid'),
    runtimeBinding: record(source.runtimeBinding, 'chat_runtime_session_binding_invalid'),
    capabilitySnapshot: parseCapabilitySnapshot(source.capabilitySnapshot),
    ...(source.activeTurn ? {
      activeTurn: record(source.activeTurn, 'chat_runtime_session_active_turn_invalid'),
    } : {}),
  };
}

function assertResolutionIdentity(
  session: ChatRuntimeSession,
  expected: ResolveSessionInput,
): void {
  if (session.provider !== expected.provider) {
    protocolFailure('chat_runtime_session_provider_mismatch');
  }
  if (session.executionAccountRef !== expected.executionAccountRef) {
    protocolFailure('chat_runtime_session_execution_account_mismatch');
  }
  const nativeSessionId = session.runtimeBinding.nativeSessionId;
  if (nativeSessionId !== expected.nativeSessionId) {
    protocolFailure('chat_runtime_native_session_mismatch');
  }
}
