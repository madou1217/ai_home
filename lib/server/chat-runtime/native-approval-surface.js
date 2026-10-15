'use strict';

// canonical 审批面（Native Approval Surface）。
//
// 一个**传输无关**的挂起-决策中枢：任何审批传输（MCP HTTP 回调、opencode serve 权限事件、
// 将来的终端确认）都只做两件事 ——
//   ① 把权限请求交给本面 request({ toolName, detail, choices, resolve })
//      → 本面发 canonical `interaction.requested`（由 composition 落库，前端按既有审批卡渲染）
//   ② 用户点按钮 → `approval.decide` 命令 → 本面 claim/finish 交互并调用 resolve(decision)
//      → 传输层把决策回填给 CLI（HTTP 响应 / POST /permission/:id/reply）
//
// 为什么不是「驱动里判 provider」：传输差异属于**传输层**（见 native-approval-transports 的策略表），
// 本面只认 canonical 词汇，因此新增 provider / 新增账号类型不需要改这里。

const crypto = require('node:crypto');

const { ChatRuntimeError } = require('./contracts');
const { InteractionResolutionCoordinator } = require('./interaction-resolution-coordinator');
const { projectInteractionResolutionForPersistence } = require('./interaction-secret-policy');

const DEFAULT_CHOICES = Object.freeze([
  Object.freeze({ id: 'choice-0', label: '允许一次', intent: 'accept' }),
  Object.freeze({ id: 'choice-1', label: '拒绝', intent: 'deny' })
]);

const CHOICE_INTENTS = new Set(['accept', 'deny', 'cancel', 'neutral']);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function summarizeInput(input) {
  try {
    const serialized = JSON.stringify(input);
    if (!serialized) return '';
    return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
  } catch (_error) {
    return '';
  }
}

function normalizeChoices(choices) {
  const source = Array.isArray(choices) && choices.length > 0 ? choices : DEFAULT_CHOICES;
  return source.map((choice, index) => {
    const intent = CHOICE_INTENTS.has(text(choice && choice.intent)) ? text(choice.intent) : 'neutral';
    return {
      id: text(choice && choice.id) || `choice-${index}`,
      label: text(choice && choice.label) || `choice-${index}`,
      ...(text(choice && choice.description) ? { description: text(choice.description) } : {}),
      intent
    };
  });
}

// 挂起审批的进程内登记：HTTP 回调（MCP 权限工具）只有 runId/sessionId 可用，用它们找回
// 发起请求的审批面。登记项只持有面本身与身份，不持有任何凭据。
const SURFACES_BY_RUN = new Map();
const SURFACES_BY_SESSION = new Map();

class NativeApprovalSurface {
  constructor(options = {}) {
    this.sessionId = text(options.sessionId);
    if (!this.sessionId) throw new ChatRuntimeError('chat_session_id_required', 500);
    this.eventSink = typeof options.eventSink === 'function' ? options.eventSink : null;
    if (!this.eventSink) throw new ChatRuntimeError('native_approval_event_sink_required', 500);
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => `interaction-approval-${crypto.randomUUID()}`;
    this.releaseFailureSink = typeof options.releaseFailureSink === 'function'
      ? options.releaseFailureSink
      : () => {};
    this.runId = '';
    this.pending = new Map(); // interactionId -> { revision, choices, resolve }
  }

  /** 绑定本次 run：HTTP 回调据此找回本面（同一会话重跑时覆盖旧绑定）。 */
  bindRun(runId) {
    const normalized = text(runId);
    if (this.runId && this.runId !== normalized) SURFACES_BY_RUN.delete(this.runId);
    this.runId = normalized;
    if (normalized) SURFACES_BY_RUN.set(normalized, this);
    SURFACES_BY_SESSION.set(this.sessionId, this);
    return this.runId;
  }

  /**
   * 登记一次权限请求。**同步返回** interactionId（传输层在事件回调里要立刻拿到 id）。
   * 落库是 fire-and-forget：失败只经 failure sink 报告，不拖垮 provider 流。
   */
  request(input = {}) {
    const interactionId = this.idFactory();
    const revision = 1;
    const choices = normalizeChoices(input.choices);
    const presentation = {
      title: text(input.title) || `允许执行 ${text(input.toolName) || '工具'} 吗？`
    };
    const description = text(input.description);
    if (description) presentation.description = description;
    const detail = text(input.detail);
    if (detail) presentation.detail = detail;
    const itemId = text(input.itemId) || `approval:${interactionId}`;
    this.pending.set(interactionId, {
      revision,
      choices,
      resolve: typeof input.resolve === 'function' ? input.resolve : () => {}
    });
    try {
      const persisted = this.eventSink({
        type: 'interaction.requested',
        payload: {
          interaction: {
            interactionId,
            itemId,
            kind: 'approval',
            revision,
            payload: { presentation, choices }
          }
        }
      });
      Promise.resolve(persisted).catch((error) => this.reportFailure(error, interactionId));
    } catch (error) {
      this.reportFailure(error, interactionId);
    }
    return interactionId;
  }

  /** HTTP 回调入口：登记 + 长挂到用户决策（形状与 legacy 审批桥一致：{behavior, message}）。 */
  accept(payload = {}, options = {}) {
    return new Promise((resolve) => {
      const interactionId = this.request({
        toolName: payload.toolName,
        detail: summarizeInput(payload.input),
        resolve: (decision) => resolve({
          behavior: decision.behavior === 'allow' ? 'allow' : 'deny',
          ...(decision.behavior === 'allow'
            ? { updatedInput: payload.input && typeof payload.input === 'object' ? payload.input : {} }
            : { message: decision.message || '用户在 webUI 拒绝了此操作' })
        })
      });
      if (typeof options.onPending === 'function') {
        try { options.onPending(interactionId); } catch (_error) { /* 调用方诊断失败不影响审批 */ }
      }
    });
  }

  /** 传输通道断开（CLI 被杀/工具端超时）：按 deny 收尾并关闭 canonical 交互。 */
  cancelPending(interactionId, reason) {
    const id = text(interactionId);
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    this.settleTransport(pending, {
      behavior: 'deny',
      reply: false,
      message: `审批通道已关闭(${reason || 'channel_closed'})`
    });
    this.closeInteraction(id);
    return true;
  }

  /** `approval.decide` 命令：先 claim/finish canonical 交互，再把决策送回传输层。 */
  async decide(context) {
    const payload = (context && context.command && context.command.payload) || {};
    const interactionId = text(payload.interactionId);
    const pending = this.pending.get(interactionId);
    if (!pending) {
      throw new ChatRuntimeError('native_session_approval_not_pending', 409, { interactionId });
    }
    const choice = pending.choices.find((entry) => entry.id === text(payload.choiceId)) || null;
    if (!choice) {
      throw new ChatRuntimeError('native_session_approval_choice_unknown', 422, {
        interactionId,
        choiceId: text(payload.choiceId)
      });
    }
    const resolution = { choiceId: choice.id, intent: choice.intent };
    const persisted = projectInteractionResolutionForPersistence(
      readInteraction(context && context.store, interactionId),
      resolution
    );
    const result = await this.createCoordinator(context).resolve(
      interactionId,
      {
        kind: 'approval',
        revision: payload.revision,
        resolution: persisted,
        sessionId: context && context.sessionId
      },
      () => this.settle(interactionId, choice)
    );
    return result.response;
  }

  settle(interactionId, choice) {
    const pending = this.pending.get(interactionId);
    if (!pending) {
      throw new ChatRuntimeError('native_session_approval_not_pending', 409, { interactionId });
    }
    this.pending.delete(interactionId);
    return this.settleTransport(pending, {
      behavior: choice.intent === 'accept' ? 'allow' : 'deny',
      choiceId: choice.id,
      ...(choice.intent === 'accept' ? {} : { message: `用户在 webUI 选择了「${choice.label}」` })
    });
  }

  settleTransport(pending, decision) {
    try {
      return pending.resolve(decision);
    } catch (error) {
      this.reportFailure(error, 'approval_transport_resolve');
      return null;
    }
  }

  /** run 结束/中止：所有挂起审批按 deny 收尾（不留下永远转圈的审批卡）。 */
  cancelAll(reason = 'run_finished') {
    let cancelled = 0;
    for (const interactionId of [...this.pending.keys()]) {
      const pending = this.pending.get(interactionId);
      this.pending.delete(interactionId);
      this.settleTransport(pending, {
        behavior: 'deny',
        reply: false,
        message: `运行已结束(${reason})，自动拒绝`
      });
      this.closeInteraction(interactionId);
      cancelled += 1;
    }
    return cancelled;
  }

  closeInteraction(interactionId) {
    try {
      const closed = this.eventSink({
        type: 'interaction.resolved',
        payload: { interactionId }
      });
      Promise.resolve(closed).catch((error) => this.reportFailure(error, interactionId));
    } catch (error) {
      this.reportFailure(error, interactionId);
    }
  }

  createCoordinator(context) {
    const store = context && context.store;
    const methods = [
      'claimInteractionResolution',
      'finishInteractionResolution',
      'releaseInteractionResolution'
    ];
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new ChatRuntimeError('chat_interaction_store_unavailable', 500);
    }
    return new InteractionResolutionCoordinator({
      claim: (interactionId, input) => store.claimInteractionResolution(interactionId, input),
      finish: (claim) => store.finishInteractionResolution(claim),
      release: (claim) => store.releaseInteractionResolution(claim)
    }, { releaseFailureSink: this.releaseFailureSink });
  }

  /** canonical 命令处理器：与 codex 驱动的 `approval.decide` 同形状，actor 无需分支。 */
  handlers() {
    return Object.freeze({
      'approval.decide': (context) => this.decide(context)
    });
  }

  reportFailure(error, scope) {
    try {
      this.releaseFailureSink({
        code: 'native_approval_surface_failure',
        scope,
        sessionId: this.sessionId,
        runId: this.runId,
        detail: String((error && error.message) || error || 'unknown_error')
      });
    } catch (_sinkError) { /* 诊断通道自身异常不影响审批语义 */ }
  }

  dispose() {
    if (this.runId) SURFACES_BY_RUN.delete(this.runId);
    if (SURFACES_BY_SESSION.get(this.sessionId) === this) SURFACES_BY_SESSION.delete(this.sessionId);
    this.cancelAll('surface_disposed');
    return true;
  }
}

function readInteraction(store, interactionId) {
  const repository = store && store.interactions;
  return repository && typeof repository.get === 'function' ? repository.get(interactionId) : null;
}

/** HTTP 回调（MCP 权限工具）找回审批面：runId 优先，其次 sessionId。 */
function lookupNativeApprovalSurface(input = {}) {
  const runId = text(input.runId);
  if (runId && SURFACES_BY_RUN.has(runId)) return SURFACES_BY_RUN.get(runId);
  const sessionId = text(input.sessionId);
  if (sessionId && SURFACES_BY_SESSION.has(sessionId)) return SURFACES_BY_SESSION.get(sessionId);
  return null;
}

function resetNativeApprovalSurfaces() {
  SURFACES_BY_RUN.clear();
  SURFACES_BY_SESSION.clear();
}

module.exports = {
  NativeApprovalSurface,
  lookupNativeApprovalSurface,
  resetNativeApprovalSurfaces
};
