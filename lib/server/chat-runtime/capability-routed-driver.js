'use strict';

const { ChatRuntimeError } = require('./contracts');
const {
  GO_INFERENCE_CHANNEL_RELAY,
  goInferenceChannel
} = require('../go-core-servable-providers');
const { findAccountsForModel } = require('../model-account-index');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

// WebUI Chat 轮次的推理入口：与 Go 侧 webuichatapi 装配的 Provider 链是同一条
// （见 internal/host/aihserver/composition.go 的 newWebUIChatHandler）。
//
// 只有在这个入口上声明了 `relayHosts.go.channel === 'relay'` 的 Provider，Go 才真的
// 能服务；canonical 通道（codex / claude / agy）有自己的上游适配器，但**没有**被接进
// 聊天切片的 Provider 链，转发过去只会得到「服务不了」。因此判定不按 Provider 名单，
// 而是读声明（与 go-core-route-deferral 的池门同一条证据链）。
const CHAT_COMPLETIONS_ENTRY_ID = 'gateway.openai.chat_completions';

/**
 * 判定「这一轮」由谁执行。
 *
 * 这是能力判定，不是开关：
 *   - 附件 / 图片：Go 切片没有附件仓库，交还 Node（旧行为能真正把文件送进模型）；
 *   - slash 命令 / compact：Go 没有命令执行，交还 Node；
 *   - 模型为空、索引未建、模型没有任何账号承载：保守交还 Node；
 *   - 候选 Provider 里只要有一个在聊天入口上不是透传通道（canonical / 未声明），
 *     交还 Node —— Go 侧征召链会在这些 Provider 上失败，而 Node 能服务。
 *
 * 候选 Provider 与 Node 的 Provider 选择同规则：模型→账号的倒排索引里谁有它，谁就是
 * 候选（见 go-core-route-deferral 的 modelCarrierProviders）。索引是**正向证据**：
 * 目录未知的账号不产生绑定，Node 也不会选它，所以不把「未知」当候选。
 *
 * @returns {{ target: 'go'|'node', reason: string, providers?: string[] }}
 */
function resolveChatTurnRoute(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {};
  const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : [];
  const imagePaths = Array.isArray(input.imagePaths) ? input.imagePaths : [];
  if (attachmentIds.length > 0 || imagePaths.length > 0) {
    return nodeRoute('attachments_require_node');
  }
  if (String(payload.name || '').trim()) return nodeRoute('slash_requires_node');
  const model = String(payload.model || policy.model || '').trim();
  if (!model) return nodeRoute('model_missing');
  const index = input.modelAccountIndex;
  // builtAt 未置位说明索引还没建：绑定分此时全为 0，Node 会走缓存/注册表回落，
  // 那条路径不在本判定的证据范围内，按未知处理（保守交还）。
  if (!index || !(index.builtAt > 0)) return nodeRoute('model_account_index_unavailable');
  const accountByRef = index.accountByRef instanceof Map ? index.accountByRef : null;
  if (!accountByRef) return nodeRoute('model_account_index_incomplete');
  const refs = findAccountsForModel(index, model);
  if (!Array.isArray(refs) || refs.length === 0) return nodeRoute('model_carriers_unknown');
  const providers = new Set();
  for (const ref of refs) {
    const account = accountByRef.get(ref);
    const provider = String(account && account.provider || '').trim().toLowerCase();
    if (!provider) return nodeRoute('model_carrier_provider_unknown');
    providers.add(provider);
  }
  // 钉选账号是独占路由：Node 只在被钉账号上找模型，所以它的 Provider 也是候选。
  // 被钉账号解析不出来时不猜（Node 会给出 pinned_account_unavailable 等确定性错误）。
  const pinnedRef = String(input.pinnedAccountRef || '').trim();
  if (pinnedRef && !isGatewayRuntimeScope(pinnedRef)) {
    const pinned = accountByRef.get(pinnedRef);
    const provider = String(pinned && pinned.provider || '').trim().toLowerCase();
    if (!provider) return nodeRoute('pinned_provider_unknown');
    providers.add(provider);
  }
  for (const provider of providers) {
    if (goInferenceChannel(provider, CHAT_COMPLETIONS_ENTRY_ID) !== GO_INFERENCE_CHANNEL_RELAY) {
      return nodeRoute(`provider_not_relay:${provider}`);
    }
  }
  return { target: 'go', reason: 'relay_chat_completions', providers: [...providers] };
}

function nodeRoute(reason) {
  return { target: 'node', reason };
}

/**
 * 组合驱动：同一个会话里按「本轮」决定由 Go 还是旧的 Node codex 驱动执行。
 *
 * 生命周期方法（interrupt / dispose / slash / compact）只委托给**当前持有轮次**的
 * 驱动；Node 驱动只在真的交还时才构造（它要拉起 codex app-server 客户端租约，
 * relay-only 的会话不应该为此付出进程与常驻资源）。
 */
class CapabilityRoutedChatDriver {
  constructor(options = {}) {
    this.session = options.session || {};
    this.getSessionPolicy = typeof options.getSessionPolicy === 'function'
      ? options.getSessionPolicy
      : () => this.session.policy || {};
    this.getModelAccountIndex = typeof options.getModelAccountIndex === 'function'
      ? options.getModelAccountIndex
      : () => null;
    this.diagnostics = typeof options.diagnostics === 'function'
      ? options.diagnostics
      : () => {};
    requireFactory(options.createGoEntry, 'createGoEntry');
    requireFactory(options.createNodeEntry, 'createNodeEntry');
    this.createGoEntry = options.createGoEntry;
    this.createNodeEntry = options.createNodeEntry;
    this.disposed = false;
    this.goEntry = null;
    this.nodeEntry = null;
    this.current = null;
  }

  startTurn(context = {}) {
    if (this.disposed) throw new ChatRuntimeError('chat_runtime_closed', 410);
    const route = this.route(context);
    const driver = route.target === 'go' ? this.goDriver() : this.nodeDriver();
    this.current = driver;
    return driver.startTurn(context);
  }

  async interruptTurn(context = {}) {
    const driver = this.current;
    if (!driver || typeof driver.interruptTurn !== 'function') {
      throw new ChatRuntimeError('chat_turn_not_active', 409);
    }
    return driver.interruptTurn(context);
  }

  // slash 命令与 compact 都是 Node 的能力：Go 切片没有命令执行。
  executeSlash(context = {}) {
    const driver = this.nodeDriver();
    this.current = driver;
    if (typeof driver.executeSlash === 'function') return driver.executeSlash(context);
    if (typeof driver.compactThread === 'function') return driver.compactThread(context);
    throw new ChatRuntimeError('chat_slash_execution_unsupported', 422);
  }

  compactThread(context = {}) {
    const driver = this.nodeDriver();
    this.current = driver;
    if (typeof driver.compactThread !== 'function') {
      throw new ChatRuntimeError('chat_slash_execution_unsupported', 422);
    }
    return driver.compactThread(context);
  }

  /**
   * 命令处理器的按需委托（SessionActor 在本地 handler 表里找不到时调用）。
   *
   * 只有 Node 真正拥有的命令（slash / 交互审批 / intervene）需要走到这里；通用命令
   * （goal/queue/policy）由 actor 自己的 handler 处理，不会触发 Node 驱动构造。
   * `runtime.prewarm` 刻意不构造驱动：预热不是轮次，不能因为页面打开就把 relay-only
   * 会话的 codex app-server 拉起来。
   */
  handlerFor(type) {
    if (this.disposed) return undefined;
    if (!this.nodeEntry && type === 'runtime.prewarm') return undefined;
    const handlers = this.ensureNodeEntry().handlers || {};
    return typeof handlers[type] === 'function' ? handlers[type] : undefined;
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.current = null;
    let disposed = false;
    if (this.nodeEntry) {
      disposed = disposeEntry(this.nodeEntry) || disposed;
      this.nodeEntry = null;
    }
    if (this.goEntry) {
      disposed = disposeEntry(this.goEntry) || disposed;
      this.goEntry = null;
    }
    return disposed;
  }

  route(context = {}) {
    const payload = (context.command && context.command.payload) || {};
    const policy = this.getSessionPolicy() || this.session.policy || {};
    // 索引读不出来（冷启动 / 端口异常）不是本轮失败的理由：按未知处理，交还 Node。
    let modelAccountIndex = null;
    try {
      modelAccountIndex = this.getModelAccountIndex();
    } catch (_error) {
      modelAccountIndex = null;
    }
    const route = resolveChatTurnRoute({
      payload,
      policy,
      imagePaths: context.imagePaths,
      pinnedAccountRef: this.session.executionAccountRef,
      modelAccountIndex
    });
    try {
      this.diagnostics({
        kind: 'chat_turn_route',
        sessionId: this.session.sessionId,
        model: String(payload.model || policy.model || ''),
        target: route.target,
        reason: route.reason,
        providers: route.providers || []
      });
    } catch (_error) { /* 诊断出口失败不影响路由 */ }
    return route;
  }

  goDriver() {
    if (!this.goEntry) this.goEntry = this.createGoEntry();
    return requireDriver(this.goEntry, 'go');
  }

  nodeDriver() {
    return requireDriver(this.ensureNodeEntry(), 'node');
  }

  ensureNodeEntry() {
    if (!this.nodeEntry) this.nodeEntry = this.createNodeEntry();
    return this.nodeEntry;
  }
}

function createCapabilityRoutedChatDriverEntry(options = {}) {
  const driver = new CapabilityRoutedChatDriver(options);
  return Object.freeze({
    provider: 'chat-routed',
    driver,
    capabilities: options.capabilities || Object.freeze({}),
    composerCatalog: typeof options.composerCatalog === 'function' ? options.composerCatalog : undefined,
    handlers: Object.freeze({})
  });
}

function requireFactory(value, name) {
  if (typeof value !== 'function') throw new Error(`capability_routed_driver_${name}_required`);
  return value;
}

function requireDriver(entry, target) {
  if (!entry || !entry.driver || typeof entry.driver.startTurn !== 'function') {
    throw new ChatRuntimeError('chat_runtime_driver_unavailable', 503, { target });
  }
  return entry.driver;
}

function disposeEntry(entry) {
  const driver = entry && entry.driver;
  return driver && typeof driver.dispose === 'function' ? driver.dispose() : false;
}

module.exports = {
  CHAT_COMPLETIONS_ENTRY_ID,
  CapabilityRoutedChatDriver,
  createCapabilityRoutedChatDriverEntry,
  resolveChatTurnRoute
};
