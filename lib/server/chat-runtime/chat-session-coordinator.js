'use strict';

const crypto = require('node:crypto');
const { ChatRuntimeError } = require('./contracts');
const { readChatSession, deleteChatSession } = require('../webui-chat-store');
const { isChatSession } = require('./chat-harness-policy');
const { entryCapabilities } = require('./session-capabilities');
const { GATEWAY_RUNTIME_SCOPE, isGatewayRuntimeScope } = require('../../account/runtime-target');
const { runtimeBindingPatch } = require('../chat-runtime-actor-registry');

class ChatSessionCoordinator {
  constructor(service, options = {}) {
    this.service = service;
    this.hostHomeDir = options.hostHomeDir;
    this.pending = new Map();
  }

  /**
   * 这次请求要钉哪个执行作用域。
   *
   * 两种目标**并存**：
   *   - 具体 accountRef → 单账号直连：harness 写 `X-Account-Ref`/`X-Provider`，
   *     由该账号自己的凭据出网（用户选哪个就是哪个，不被池化覆盖）；
   *   - `gateway` / 空 → aih-server：不钉账号，网关按模型在池里挑号。
   *
   * 2026-11-04 前这里无条件收敛到 gateway，账号选择器只是装饰 —— 用户选了单账号，
   * 请求仍走池化，和「单账号可直接使用」的预期相反。选择权必须交给调用方。
   */
  resolveExecutionScope(input = {}) {
    const requested = String(input.executionAccountRef || '').trim();
    return requested && !isGatewayRuntimeScope(requested)
      ? requested
      : GATEWAY_RUNTIME_SCOPE;
  }

  async open(input) {
    const id = String(input.chatSessionId || '').trim();
    if (!id) return this.create(input);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ChatRuntimeError('chat_session_id_invalid', 400);
    const existing = this.service.store.getSession(id);
    if (existing) {
      // 第二个 WebUI 入口可以只读观察同一会话。只读打开绝不触发凭据重绑定，
      // 因而不会因为首个入口正在运行而把整个会话页锁死。
      if (input.readOnly && isChatSession(existing) && existing.provider === input.provider) {
        return existing;
      }
      // chat 没有账号区别：任何账号打开同一会话都落在同一个全局 harness（见 retarget）。
      if (isChatSession(existing) && existing.provider === input.provider) {
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
    // chat 一律网关作用域：会话归属只认 provider，账号只是这次请求的路由（池化/别名），
    // 所以任何账号都能打开、继续同一个 chat。
    if (isGatewayRuntimeScope(session.executionAccountRef)) return session;
    // 存量账号作用域会话：作用域必须一致（迁移前创建的老数据）。
    const inputScope = isGatewayRuntimeScope(input.executionAccountRef);
    if (inputScope || session.executionAccountRef !== input.executionAccountRef) {
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
    // harness home 仍然是全局的（见 harnessScopeDir），换作用域只改这次请求的钉选头。
    const next = this.resolveExecutionScope(input);
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
        capabilitySnapshot: entryCapabilities(prepared.entry, candidate) || session.capabilitySnapshot
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
      executionAccountRef: this.resolveExecutionScope(input),
      projectPath: '',
      policy: {
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
    id: session.sessionId, runtimeSessionId: session.sessionId, projectPath: session.projectPath,
    provider: session.provider, accountRef: session.executionAccountRef,
    title: session.policy.title || '新对话', updatedAt: session.updatedAt,
    model: session.policy.model || '', status: session.state
  };
}

module.exports = { ChatSessionCoordinator, chatSessionSummary, legacyResponseItems };
