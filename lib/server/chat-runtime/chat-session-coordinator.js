'use strict';

const crypto = require('node:crypto');
const { ChatRuntimeError } = require('./contracts');
const { readChatSession, deleteChatSession } = require('../webui-chat-store');
const { isChatSession } = require('./chat-harness-policy');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');
const { runtimeBindingPatch } = require('../chat-runtime-actor-registry');

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
    if (existing) {
      // 同 provider 换账号 = 换执行凭据，不是换会话：时间线、会话 id 都不动，只把 harness
      // 重绑到新账号（新 home 是空的，历史由 history seed 回填，与崩溃恢复同一条路径）。
      if (isChatSession(existing) && existing.provider === input.provider
        && existing.executionAccountRef !== input.executionAccountRef) {
        return this.retarget(existing, input);
      }
      return this.requireOwner(existing, input);
    }
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

  /**
   * 同 provider 换执行账号：会话身份（sessionId / 时间线 / provider）全部不变，只把
   * executionAccountRef 换成另一个凭据，并把 harness 重绑过去。
   *
   * 新 harness home 里没有原生 thread，但会话历史由 history seed 回填（chat-runtime-composition
   * 的 initialHistory，与崩溃恢复同一条路径），所以「换个账号接着聊」= 重绑 + 回填，不是新会话。
   * 一轮正在跑时拒绝切换（assertReplaceable → chat_execution_credential_change_conflict）。
   */
  async retarget(session, input) {
    const next = String(input.executionAccountRef || '').trim();
    if (!next) throw new ChatRuntimeError('chat_session_execution_account_required', 400);
    if (next === session.executionAccountRef) return session;
    const candidate = { ...session, executionAccountRef: next };
    this.service.actors.assertReplaceable(session.sessionId);
    let prepared;
    try {
      prepared = await this.service.actors.prepare(candidate);
      this.service.actors.assertReplaceable(session.sessionId);
      const updated = this.service.store.updateExecutionContext(session.sessionId, {
        executionAccountRef: next,
        runtimeBinding: runtimeBindingPatch(candidate, prepared.runtime),
        capabilitySnapshot: prepared.entry.capabilities || session.capabilitySnapshot
      });
      this.service.actors.replacePrepared(updated, prepared);
      return updated;
    } finally {
      this.service.actors.disposePrepared(prepared);
    }
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

  /**
   * 删除 canonical 会话时同步清掉它导入的 legacy 聊天文件（best-effort）。
   * 只删 canonical 行不动文件的话，聊天列表会把导入前的旧条目重新列出来（列表用
   * legacySessionId 反查已迁移集合，行一没就复活）。
   */
  cleanupLegacySource(session) {
    const legacySessionId = String(session && session.policy && session.policy.legacySessionId || '').trim();
    if (!legacySessionId) return false;
    return deleteChatSession(legacySessionId, this.hostHomeDir);
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
