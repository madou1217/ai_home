'use strict';

const crypto = require('node:crypto');
const { ChatRuntimeError } = require('./contracts');
const { readChatSession } = require('../webui-chat-store');
const { isChatSession } = require('./chat-harness-policy');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

class ChatSessionCoordinator {
  constructor(service, options = {}) {
    this.service = service;
    this.hostHomeDir = options.hostHomeDir;
    this.pending = new Map();
  }

  async open(input) {
    const id = String(input.chatSessionId || '').trim();
    if (!id) return this.create(input);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ChatRuntimeError('chat_session_id_invalid', 400);
    const existing = this.service.store.getSession(id);
    if (existing) return this.requireOwner(existing, input);
    const legacy = readChatSession(id, this.hostHomeDir);
    if (!legacy) throw new ChatRuntimeError('chat_session_not_found', 404);
    const gatewayScope = isGatewayRuntimeScope(input.executionAccountRef);
    // 网关作用域的会话不绑账号：legacy 记录里通常没有 accountRef，provider 相同即可导入。
    const accountMismatch = gatewayScope
      ? Boolean(legacy.accountRef && !isGatewayRuntimeScope(legacy.accountRef))
      : Boolean(legacy.accountRef && legacy.accountRef !== input.executionAccountRef);
    if (legacy.provider !== input.provider || accountMismatch) {
      throw new ChatRuntimeError('chat_session_account_mismatch', 409);
    }
    const importedId = `chat-import-${crypto.createHash('sha256').update(id).digest('hex')}`;
    const imported = this.service.store.getSession(importedId);
    if (imported) return this.requireOwner(imported, input);
    if (this.pending.has(importedId)) {
      return this.requireOwner(await this.pending.get(importedId), input);
    }
    const pending = this.create(input, { sessionId: importedId, legacy });
    this.pending.set(importedId, pending);
    try { return await pending; } finally { this.pending.delete(importedId); }
  }

  requireOwner(session, input) {
    if (!isChatSession(session) || session.provider !== input.provider) {
      throw new ChatRuntimeError('chat_session_account_mismatch', 409);
    }
    // 网关作用域（aih-server）没有账号身份：归属只认 provider + 作用域本身。
    const sessionScope = isGatewayRuntimeScope(session.executionAccountRef);
    const inputScope = isGatewayRuntimeScope(input.executionAccountRef);
    if (sessionScope !== inputScope || (!sessionScope && session.executionAccountRef !== input.executionAccountRef)) {
      throw new ChatRuntimeError('chat_session_account_mismatch', 409);
    }
    return session;
  }

  async create(input, { sessionId, legacy } = {}) {
    const session = await this.service.createSession({
      sessionId,
      provider: input.provider,
      executionAccountRef: input.executionAccountRef,
      projectPath: '',
      policy: {
        workspaceMode: 'chat',
        approvalMode: 'confirm',
        title: legacy && legacy.title || '新对话',
        ...(legacy ? { legacySessionId: legacy.id } : {})
      }
    });
    if (legacy) this.service.store.importTimeline(session.sessionId, legacyTimeline(session, legacy));
    return session;
  }
}

function legacyMessages(legacy) {
  return (Array.isArray(legacy && legacy.messages) ? legacy.messages : []).filter((message) => (
    ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content
  ));
}

function legacyResponseItems(legacy) {
  return legacyMessages(legacy).map((message) => ({
    type: 'message', role: message.role,
    content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
  }));
}

function legacyTimeline(session, legacy) {
  return legacyMessages(legacy).map((message, index) => {
    const id = `${session.sessionId}-legacy-${index}`;
    const at = Number(message.timestamp) || Number(legacy.createdAt) || session.createdAt;
    return {
      eventId: id, type: 'timeline.item.completed', at, itemId: id,
      source: { provider: session.provider, runtimeId: 'legacy-chat-import' },
      payload: { item: {
        id, kind: 'message', detail: { role: message.role },
        status: 'completed', content: message.content, createdAt: at, updatedAt: at
      } }
    };
  });
}

function chatSessionSummary(session) {
  return {
    id: session.sessionId, runtimeSessionId: session.sessionId, mode: 'chat',
    provider: session.provider, accountRef: session.executionAccountRef,
    title: session.policy.title || '新对话', updatedAt: session.updatedAt,
    model: session.policy.model || '', status: session.state
  };
}

module.exports = { ChatSessionCoordinator, chatSessionSummary, legacyResponseItems };
