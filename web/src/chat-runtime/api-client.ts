import {
  assertSessionId,
  protocolFailure,
  record,
  text,
} from './dto-guards';
import {
  parseCommandCatalog,
  parseAttachmentResponse,
  parseComposerCatalog,
  parseCommandResponse,
  parseCreatedSession,
  parseSessionResolution,
  parseSessionList,
  parseSnapshotResponse,
  parseTimelineResponse,
} from './api-dto-parser';
import type {
  ChatRuntimeApi,
  ChatRuntimeAttachment,
  ChatRuntimeAttachmentUpload,
  ChatRuntimeCommandResult,
  ChatRuntimeEventStream,
  ChatRuntimeSession,
  ChatRuntimeTransport,
  CommandCatalogEntry,
  ComposerCatalog,
  CreateSessionInput,
  ResolveSessionInput,
  SessionResolution,
  SessionListQuery,
  TimelinePage,
  TimelineQuery,
} from './api-types';
import type { ChatRuntimeCommand, SessionSnapshot } from './types';

const SESSIONS_PATH = '/v0/webui/chat/sessions';
const SESSION_RESOLVE_PATH = `${SESSIONS_PATH}/resolve`;
const ARTIFACTS_PATH = '/v0/webui/chat/artifacts';

export class ChatRuntimeApiClient implements ChatRuntimeApi {
  constructor(private readonly transport: ChatRuntimeTransport) {}

  async createSession(input: CreateSessionInput): Promise<ChatRuntimeSession> {
    return parseCreatedSession(await this.requestJson(SESSIONS_PATH, jsonRequest('POST', input)));
  }

  async resolveSession(input: ResolveSessionInput): Promise<SessionResolution> {
    const normalized = normalizeResolutionInput(input);
    const response = await this.requestJson(
      SESSION_RESOLVE_PATH,
      jsonRequest('POST', normalized),
    );
    return parseSessionResolution(response, normalized);
  }

  async listSessions(query: SessionListQuery = {}): Promise<readonly ChatRuntimeSession[]> {
    return parseSessionList(await this.requestJson(withQuery(SESSIONS_PATH, query)));
  }

  async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    const response = await this.requestJson(sessionPath(id, '/snapshot'));
    return parseSnapshotResponse(response, id);
  }

  async readTimeline(sessionId: string, query: TimelineQuery = {}): Promise<TimelinePage> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    const path = withQuery(sessionPath(id, '/timeline'), query);
    return parseTimelineResponse(await this.requestJson(path), id);
  }

  async dispatchCommand(
    sessionId: string,
    command: ChatRuntimeCommand,
  ): Promise<ChatRuntimeCommandResult> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    assertSessionId(command.sessionId, id);
    const response = await this.requestJson(sessionPath(id, '/commands'), jsonRequest('POST', command));
    return parseCommandResponse(response, id, command.commandId);
  }

  async getCommandCatalog(sessionId: string): Promise<readonly CommandCatalogEntry[]> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    return parseCommandCatalog(await this.requestJson(sessionPath(id, '/commands/catalog')));
  }

  async getComposerCatalog(sessionId: string): Promise<ComposerCatalog> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    return parseComposerCatalog(await this.requestJson(sessionPath(id, '/composer/catalog')));
  }

  async uploadAttachments(
    sessionId: string,
    attachments: readonly ChatRuntimeAttachmentUpload[],
  ): Promise<readonly ChatRuntimeAttachment[]> {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    const response = await this.requestJson(
      sessionPath(id, '/attachments'),
      jsonRequest('POST', { attachments }),
    );
    return parseAttachmentResponse(response, id);
  }

  async readArtifact(artifactId: string): Promise<Blob> {
    const id = requiredIdentity(artifactId, 'chat_runtime_artifact_id_invalid');
    return this.transport.fetchBlob(`${ARTIFACTS_PATH}/${encodeURIComponent(id)}`);
  }

  openEvents(sessionId: string, after: number): ChatRuntimeEventStream {
    const id = requiredIdentity(sessionId, 'chat_runtime_session_id_invalid');
    if (!Number.isSafeInteger(after) || after < 0) protocolFailure('chat_runtime_event_cursor_invalid');
    return this.transport.openEvents(withQuery(sessionPath(id, '/events'), { after }));
  }

  private async requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.transport.fetch(path, init);
    if (!response.ok) throw await httpError(response);
    const payload = await readJson(response);
    const result = record(payload, 'chat_runtime_response_invalid');
    if (result.ok !== true) protocolFailure('chat_runtime_response_not_ok');
    return result;
  }
}

function sessionPath(sessionId: string, suffix: string): string {
  return `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}${suffix}`;
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams();
  Object.entries(values as Record<string, unknown>).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function requiredIdentity(value: unknown, code: string): string {
  return text(value, code).trim();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return protocolFailure('chat_runtime_response_json_invalid');
  }
}

export class ChatRuntimeApiError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'ChatRuntimeApiError';
  }
}

function normalizeResolutionInput(input: ResolveSessionInput): ResolveSessionInput {
  return {
    ...input,
    provider: requiredIdentity(input.provider, 'chat_runtime_session_provider_invalid'),
    executionAccountRef: requiredIdentity(
      input.executionAccountRef,
      'chat_runtime_session_execution_account_invalid',
    ),
    nativeSessionId: requiredIdentity(
      input.nativeSessionId,
      'chat_runtime_native_session_id_invalid',
    ),
  };
}

async function httpError(response: Response): Promise<Error> {
  let code = `chat_runtime_http_${response.status}`;
  let details: unknown;
  try {
    const payload = record(await response.json(), 'chat_runtime_error_response_invalid');
    code = typeof payload.error === 'string' && payload.error ? payload.error : code;
    details = payload.details;
  } catch (_error) {}
  return new ChatRuntimeApiError(code, response.status, details);
}
