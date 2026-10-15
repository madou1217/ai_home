'use strict';

// **Provider 能力描述符**契约 —— 叶子模块，只做形状校验，无 I/O。
//
// 设计目标：新增 provider 只写它自己的一个文件，不在任何中央名单里加行。因此：
//   * 每个 provider 一个描述符（`lib/providers/defs/<id>.js`），**自己声明自己的全部能力**；
//   * 注册表只做索引（provider → 能力、能力 → providers 的**倒排**），不持有 provider 名单；
//   * 每个能力在描述符里统一形状，消费方按能力名取，不认 provider 名。
//
// 描述符形状（contractVersion = 1）：
//   { contractVersion, id, capabilities: { <capability>: <payload> } }
//
// 能力 `quota` 必须**显式回答**：要么 supported: true 并给出策略链，要么 supported: false 并给出
// reason（为什么拿不到额度）。「哪些 provider 没有额度」由每个 provider 自己回答，
// 不存在需要同步维护的中央清单。
//
//   支持时：{ supported: true, kind, source, shape, entryShape,
//             strategies: [ { id, transport, clientDependent, probe|handler } ] }
//     - kind 必须已在 USAGE_SNAPSHOT_KINDS 登记（否则 remainingPct 提取不出来）
//     - transport: 'http' | 'client-cli' | 'client-desktop'（'http' = 不依赖本机客户端）
//     - clientDependent: 该策略是否依赖本机客户端（注册表据此把最稳的排前面）
//     - probe: (deps) => { probe(accountRef, timeoutMs) => { snapshot } | { error, auth? } }
//     - handler: 原生探针 id（实现由组合根 lib/cli/services/usage/snapshot.js 提供，
//       与 codex/claude/agy/gemini 既有刷新阶梯一致）
//
// 能力 `usage`（账号页/CLI 用量展示端口）与 `relay`（推理通道）同样是自描述数据。

const { USAGE_SNAPSHOT_KINDS } = require('../account/usage-remaining');

const PROVIDER_DESCRIPTOR_CONTRACT_VERSION = 1;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const QUOTA_TRANSPORTS = Object.freeze(['http', 'client-cli', 'client-desktop']);
const QUOTA_SNAPSHOT_SHAPES = Object.freeze(['entries', 'models']);
const QUOTA_ENTRY_SHAPES = Object.freeze(['window', 'bucket', 'models']);
const RELAY_TRANSPORTS = Object.freeze(['http', 'client-cli', 'none']);
const CAPABILITY_NAMES = Object.freeze(['quota', 'models', 'usage', 'relay', 'authSources', 'hooks']);
// 认证来源的两条轴：来源形态（本机登录态 / 需要交互）与它依赖的客户端形态。
const AUTH_SOURCE_KINDS = Object.freeze(['local', 'remote']);
const AUTH_SOURCE_APPS = Object.freeze(['desktop', 'cli']);
// 来源的**执行方式**词汇表（与契约 authOptions 一样是数据，不是代码分支）：
//   device-code      —— 设备码授权任务（kiro）
//   paste-token      —— 用户粘贴 refresh_token（kiro）
//   host-account-scan—— 本机登录态由既有「扫描本机账号」整批入库（codebuddy 家族 / cline）
const AUTH_SOURCE_HANDLERS = Object.freeze(['device-code', 'paste-token', 'host-account-scan']);

// 模型发现的传输通道：
//   http  = 直连厂商接口（不依赖本机客户端）
//   cli   = 跑本地 CLI / App 内嵌运行时（依赖本机客户端）
//   local = 本地静态清单（不联网、也不依赖客户端）
const MODEL_TRANSPORTS = Object.freeze(['http', 'cli', 'local']);

// 账号模式：同一个 provider 的登录态（oauth）与 API Key 账号可能走完全不同的实现面，
// 由策略自己声明适用模式（数据驱动），而不是在派发代码里 if (apiKeyMode)。
const MODEL_MODES = Object.freeze(['login', 'api-key']);

// 会话 Hook 的**写入格式适配器**（Go 合同 sessionSync.adapter 已按 provider 声明）：
//   json_hooks        —— 事件 → [{hooks:[…]}] 的 JSON 结构（codex / claude / gemini / grok）
//   agy_named_hooks   —— 顶层具名 hook 定义，事件值形状不同（agy）
//   opencode_plugin   —— 插件桥，不是 JSON 事件清单（opencode）
// 描述符只声明「档案数据」（目标路径段、超时单位、事件 matcher、是否带特性开关），格式实现留在适配器。
const HOOK_ADAPTER_IDS = Object.freeze(['json_hooks', 'agy_named_hooks', 'opencode_plugin']);
const HOOK_TIMEOUT_UNITS = Object.freeze(['seconds', 'ms']);

function validateHooksCapability(id, hooks) {
  if (!isPlainObject(hooks)) throw descriptorError('provider_descriptor_hooks_invalid', id);
  if (hooks.supported === false) {
    const reason = normalizeText(hooks.reason);
    if (!reason) throw descriptorError('provider_descriptor_hooks_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (hooks.supported !== true) throw descriptorError('provider_descriptor_hooks_supported_flag_invalid', id);
  const adapter = normalizeText(hooks.adapter);
  if (!HOOK_ADAPTER_IDS.includes(adapter)) {
    throw descriptorError('provider_descriptor_hooks_adapter_unknown', `${id}:${adapter}`);
  }
  const target = Array.isArray(hooks.target)
    ? Object.freeze(hooks.target.map(normalizeText).filter(Boolean))
    : Object.freeze([]);
  const timeoutUnit = normalizeText(hooks.timeoutUnit) || 'seconds';
  if (!HOOK_TIMEOUT_UNITS.includes(timeoutUnit)) {
    throw descriptorError('provider_descriptor_hooks_timeout_unit_unknown', `${id}:${timeoutUnit}`);
  }
  const eventMatchers = Object.freeze(Object.fromEntries(
    Object.entries(isPlainObject(hooks.eventMatchers) ? hooks.eventMatchers : {})
      .map(([eventName, matcher]) => [eventName, normalizeText(matcher)])
      .filter(([, matcher]) => Boolean(matcher))
  ));
  return Object.freeze({
    supported: true,
    adapter,
    target,
    timeoutUnit,
    eventMatchers,
    // 目标文件旁边还有一份特性开关需要一起打开（codex 的 config.toml）。
    featureFlag: hooks.featureFlag === true
  });
}

class ProviderDescriptorError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ProviderDescriptorError';
    this.code = code;
    this.detail = String(detail || '');
  }
}

function descriptorError(code, detail) {
  const text = detail === undefined || detail === null ? '' : String(detail).trim();
  return new ProviderDescriptorError(code, text === 'undefined' || text === 'null' ? '' : text);
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const KNOWN_SNAPSHOT_KINDS = new Set(Object.values(USAGE_SNAPSHOT_KINDS));

function validateModelsCapability(id, models) {
  if (!isPlainObject(models)) throw descriptorError('provider_descriptor_models_invalid', id);
  if (models.supported === false) {
    const reason = normalizeText(models.reason);
    if (!reason) throw descriptorError('provider_descriptor_models_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (models.supported !== true) throw descriptorError('provider_descriptor_models_supported_flag_invalid', id);
  const rawStrategies = Array.isArray(models.strategies) ? models.strategies : [];
  if (rawStrategies.length === 0) throw descriptorError('provider_descriptor_models_strategies_missing', id);
  const seen = new Set();
  const strategies = rawStrategies.map((strategy) => {
    if (!isPlainObject(strategy)) throw descriptorError('provider_descriptor_models_strategy_invalid', id);
    const strategyId = normalizeText(strategy.id);
    if (!strategyId) throw descriptorError('provider_descriptor_models_strategy_id_missing', id);
    if (seen.has(strategyId)) throw descriptorError('provider_descriptor_models_strategy_duplicate', strategyId);
    seen.add(strategyId);
    const transport = normalizeText(strategy.transport);
    if (!MODEL_TRANSPORTS.includes(transport)) {
      throw descriptorError('provider_descriptor_models_transport_invalid', transport);
    }
    const clientDependent = Boolean(strategy.clientDependent);
    // 与额度策略同一条自洽规则：只有 cli 通道允许（且必须）声明依赖客户端。
    if (transport === 'cli' && !clientDependent) {
      throw descriptorError('provider_descriptor_models_transport_conflict', strategyId);
    }
    if (transport !== 'cli' && clientDependent) {
      throw descriptorError('provider_descriptor_models_transport_conflict', strategyId);
    }
    // 两种实现声明方式（与额度策略一致）：内联工厂 discover，或注册表 handler id
    // （实现由组合根注册，描述符只声明用哪个 —— 这是「新增 provider 不动派发代码」的关键）。
    const rawModes = Array.isArray(strategy.modes) ? strategy.modes : [];
    const modes = rawModes.map((mode) => normalizeText(mode).toLowerCase()).filter(Boolean);
    for (const mode of modes) {
      if (!MODEL_MODES.includes(mode)) throw descriptorError('provider_descriptor_models_mode_invalid', mode);
    }
    // CLI 通道的参数表也由描述符声明（中央 provider→CLI 参数表已删除）：
    //   args: CLI 参数；format: 输出解析格式；configDirFlag: 账号目录参数；discover: 特殊发现器 id。
    const rawCli = isPlainObject(strategy.cli) ? strategy.cli : null;
    let cli = null;
    if (rawCli) {
      const args = Array.isArray(rawCli.args) ? rawCli.args.map((arg) => String(arg)) : [];
      cli = Object.freeze({
        args: Object.freeze(args),
        format: normalizeText(rawCli.format) || 'lines',
        configDirFlag: normalizeText(rawCli.configDirFlag),
        discover: normalizeText(rawCli.discover),
        minTimeoutMs: Number(rawCli.minTimeoutMs) > 0 ? Number(rawCli.minTimeoutMs) : 0
      });
    }
    if (transport === 'cli' && !cli) {
      throw descriptorError('provider_descriptor_models_cli_spec_missing', strategyId);
    }
    const discover = typeof strategy.discover === 'function' ? strategy.discover : null;
    const handler = normalizeText(strategy.handler);
    if (!discover && !handler) throw descriptorError('provider_descriptor_models_strategy_impl_missing', strategyId);
    if (discover && handler) throw descriptorError('provider_descriptor_models_strategy_impl_ambiguous', strategyId);
    return Object.freeze({
      id: strategyId,
      transport,
      clientDependent,
      discover,
      handler,
      cli,
      modes: Object.freeze(modes),
      description: normalizeText(strategy.description)
    });
  });
  // 「只有依赖本机客户端的通道」必须显式回答为什么没有客户端无关的通道 ——
  // 这正是 2026-10-15 kiro 事故的形态：没人回答过，于是「没装 CLI」= 采集全废且看不出原因。
  const hasClientFreeStrategy = strategies.some((strategy) => strategy.clientDependent !== true);
  const clientFreeReason = normalizeText(models.clientFreeReason);
  if (!hasClientFreeStrategy && !clientFreeReason) {
    throw descriptorError('provider_descriptor_models_client_free_reason_missing', id);
  }
  return Object.freeze({
    supported: true,
    source: normalizeText(models.source),
    clientFreeReason: hasClientFreeStrategy ? '' : clientFreeReason,
    strategies: Object.freeze(strategies)
  });
}

function validateQuotaCapability(id, quota) {
  if (!isPlainObject(quota)) throw descriptorError('provider_descriptor_quota_invalid', id);
  if (quota.supported === false) {
    const reason = normalizeText(quota.reason);
    // 「没有额度」必须带原因：否则下一个人只能靠猜。
    if (!reason) throw descriptorError('provider_descriptor_quota_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (quota.supported !== true) throw descriptorError('provider_descriptor_quota_supported_flag_invalid', id);
  const kind = normalizeText(quota.kind);
  if (!kind) throw descriptorError('provider_descriptor_quota_kind_missing', id);
  if (!KNOWN_SNAPSHOT_KINDS.has(kind)) throw descriptorError('provider_descriptor_quota_kind_unregistered', kind);
  const source = normalizeText(quota.source);
  if (!source) throw descriptorError('provider_descriptor_quota_source_missing', id);
  const shape = normalizeText(quota.shape) || 'entries';
  if (!QUOTA_SNAPSHOT_SHAPES.includes(shape)) throw descriptorError('provider_descriptor_quota_shape_invalid', shape);
  const entryShape = normalizeText(quota.entryShape) || 'window';
  if (!QUOTA_ENTRY_SHAPES.includes(entryShape)) {
    throw descriptorError('provider_descriptor_quota_entry_shape_invalid', entryShape);
  }
  const rawStrategies = Array.isArray(quota.strategies) ? quota.strategies : [];
  if (rawStrategies.length === 0) throw descriptorError('provider_descriptor_quota_strategies_missing', id);
  const seen = new Set();
  const strategies = rawStrategies.map((strategy) => {
    if (!isPlainObject(strategy)) throw descriptorError('provider_descriptor_quota_strategy_invalid', id);
    const strategyId = normalizeText(strategy.id);
    if (!strategyId) throw descriptorError('provider_descriptor_quota_strategy_id_missing', id);
    if (seen.has(strategyId)) throw descriptorError('provider_descriptor_quota_strategy_duplicate', strategyId);
    seen.add(strategyId);
    const transport = normalizeText(strategy.transport);
    if (!QUOTA_TRANSPORTS.includes(transport)) throw descriptorError('provider_descriptor_quota_transport_invalid', transport);
    const clientDependent = Boolean(strategy.clientDependent);
    // clientDependent 与 transport 必须自洽：http 通道不该声明依赖客户端。
    if (transport === 'http' && clientDependent) {
      throw descriptorError('provider_descriptor_quota_transport_conflict', strategyId);
    }
    if (transport !== 'http' && !clientDependent) {
      throw descriptorError('provider_descriptor_quota_transport_conflict', strategyId);
    }
    // clientOptional：不依赖客户端也能跑，但可能会顺手读一下客户端（例如 codex --version）。
    const clientOptional = Boolean(strategy.clientOptional);
    if (clientDependent && clientOptional) {
      throw descriptorError('provider_descriptor_quota_transport_conflict', strategyId);
    }
    const probe = typeof strategy.probe === 'function' ? strategy.probe : null;
    const handler = normalizeText(strategy.handler);
    if (!probe && !handler) throw descriptorError('provider_descriptor_quota_strategy_impl_missing', strategyId);
    if (probe && handler) throw descriptorError('provider_descriptor_quota_strategy_impl_ambiguous', strategyId);
    return Object.freeze({
      id: strategyId,
      transport,
      clientDependent,
      clientOptional,
      probe,
      handler,
      description: normalizeText(strategy.description)
    });
  });
  return Object.freeze({
    supported: true,
    kind,
    source,
    shape,
    entryShape,
    strategies: Object.freeze(strategies)
  });
}

function validateRelayCapability(id, relay) {
  if (!isPlainObject(relay)) throw descriptorError('provider_descriptor_relay_invalid', id);
  const transport = normalizeText(relay.transport);
  if (!RELAY_TRANSPORTS.includes(transport)) throw descriptorError('provider_descriptor_relay_transport_invalid', transport);
  const clientDependent = Boolean(relay.clientDependent);
  if (transport === 'http' && clientDependent) throw descriptorError('provider_descriptor_relay_transport_conflict', id);
  if (transport === 'none' && clientDependent) throw descriptorError('provider_descriptor_relay_transport_conflict', id);
  return Object.freeze({
    transport,
    clientDependent,
    reason: normalizeText(relay.reason),
    strategy: normalizeText(relay.strategy)
  });
}

/**
 * 校验「认证来源」能力：把「这个 provider 在当前宿主机上有哪些可用的账号来源」变成可声明数据。
 *
 * 不变量：
 *   * `kind === 'local'`（读本机登录态）必须 `clientDependent: true` 且声明 `requires.app`
 *     —— 读本机状态就是依赖客户端，且必须说清读的是桌面端还是 CLI，否则 UI 无从判断可用性；
 *   * `kind === 'remote'`（设备码 / 粘贴 token 等）不得声明 `requires.app`（它们不依赖客户端）；
 *   * 每个来源必须且只能给出一种实现：`import`（工厂，返回 { import(options) }）或 `handler`（任务流程名）。
 */
function validateAuthSourcesCapability(id, value) {
  if (!isPlainObject(value)) throw descriptorError('provider_descriptor_auth_sources_invalid', id);
  const sources = Array.isArray(value.sources) ? value.sources : [];
  if (sources.length === 0) throw descriptorError('provider_descriptor_auth_sources_empty', id);
  const seen = new Set();
  const normalized = sources.map((source) => {
    if (!isPlainObject(source)) throw descriptorError('provider_descriptor_auth_source_invalid', id);
    const sourceId = normalizeText(source.id);
    if (!sourceId) throw descriptorError('provider_descriptor_auth_source_id_missing', id);
    if (seen.has(sourceId)) throw descriptorError('provider_descriptor_auth_source_duplicate', sourceId);
    seen.add(sourceId);
    const kind = normalizeText(source.kind);
    if (!AUTH_SOURCE_KINDS.includes(kind)) throw descriptorError('provider_descriptor_auth_source_kind_invalid', sourceId);
    const clientDependent = Boolean(source.clientDependent);
    const requiresApp = normalizeText(source.requires && source.requires.app);
    if (requiresApp && !AUTH_SOURCE_APPS.includes(requiresApp)) {
      throw descriptorError('provider_descriptor_auth_source_requires_invalid', sourceId);
    }
    if (kind === 'local' && (!clientDependent || !requiresApp)) {
      throw descriptorError('provider_descriptor_auth_source_local_contract', sourceId);
    }
    if (kind === 'remote' && requiresApp) {
      throw descriptorError('provider_descriptor_auth_source_remote_requires_app', sourceId);
    }
    const factory = typeof source.import === 'function' ? source.import : null;
    const handler = normalizeText(source.handler);
    if (!factory && !handler) throw descriptorError('provider_descriptor_auth_source_impl_missing', sourceId);
    if (factory && handler) throw descriptorError('provider_descriptor_auth_source_impl_ambiguous', sourceId);
    if (handler && !AUTH_SOURCE_HANDLERS.includes(handler)) {
      throw descriptorError('provider_descriptor_auth_source_handler_invalid', sourceId);
    }
    return Object.freeze({
      id: sourceId,
      kind,
      clientDependent,
      requires: Object.freeze({ app: requiresApp }),
      // 该来源对应哪个「认证方式」（Go 契约的 authOptions.value）：一个认证方式可以有多个来源
      // （例如 refresh_token 既有本机 IDE 登录态、也有用户粘贴），UI 按可用性挑最合适的那一个。
      authMode: normalizeText(source.authMode),
      import: factory,
      handler,
      // 本机登录态的**指纹**（离线可比）：用来判断「这份登录态是不是已经在账号池里了」。
      // 与 capability.accountIdentity 必须同源（同一函数算出来的键才可比）。
      identity: typeof source.identity === 'function' ? source.identity : null,
      // 来源自报可用性：本机来源的真实信号是「凭据读得到」，不是「二进制装没装」
      // （装了桌面端没装 CLI 时，按二进制判定会误报不可用）。
      available: typeof source.available === 'function' ? source.available : null,
      description: normalizeText(source.description)
    });
  });
  return Object.freeze({
    supported: true,
    // provider 级：已入库账号的指纹提取器（账号侧），与来源级 identity 成对使用。
    accountIdentity: typeof value.accountIdentity === 'function' ? value.accountIdentity : null,
    sources: Object.freeze(normalized)
  });
}

/** 校验并冻结一个 provider 描述符。失败抛 ProviderDescriptorError（调用方记为可观察错误）。 */
function validateProviderDescriptor(input) {
  if (!isPlainObject(input)) throw descriptorError('provider_descriptor_invalid');
  const contractVersion = Number(input.contractVersion);
  if (contractVersion !== PROVIDER_DESCRIPTOR_CONTRACT_VERSION) {
    throw descriptorError('provider_descriptor_contract_version_unsupported', String(input.contractVersion));
  }
  const id = normalizeText(input.id).toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id)) throw descriptorError('provider_descriptor_id_invalid', id);
  const capabilities = isPlainObject(input.capabilities) ? input.capabilities : {};
  for (const name of Object.keys(capabilities)) {
    if (!CAPABILITY_NAMES.includes(name)) throw descriptorError('provider_descriptor_capability_unknown', name);
  }
  if (!Object.prototype.hasOwnProperty.call(capabilities, 'quota')) {
    // 额度必须显式回答：不支持也要写 reason，杜绝「没人想过」的静默缺口。
    throw descriptorError('provider_descriptor_quota_missing', id);
  }
  const normalized = { quota: validateQuotaCapability(id, capabilities.quota) };
  if (capabilities.models !== undefined) normalized.models = validateModelsCapability(id, capabilities.models);
  if (capabilities.hooks !== undefined) normalized.hooks = validateHooksCapability(id, capabilities.hooks);
  if (capabilities.relay !== undefined) normalized.relay = validateRelayCapability(id, capabilities.relay);
  if (capabilities.authSources !== undefined) {
    normalized.authSources = validateAuthSourcesCapability(id, capabilities.authSources);
  }
  if (capabilities.usage !== undefined) {
    if (!isPlainObject(capabilities.usage)) throw descriptorError('provider_descriptor_usage_invalid', id);
    normalized.usage = Object.freeze({ ...capabilities.usage });
  }
  return Object.freeze({ contractVersion, id, capabilities: Object.freeze(normalized) });
}

module.exports = {
  PROVIDER_DESCRIPTOR_CONTRACT_VERSION,
  PROVIDER_ID_PATTERN,
  QUOTA_TRANSPORTS,
  QUOTA_SNAPSHOT_SHAPES,
  QUOTA_ENTRY_SHAPES,
  RELAY_TRANSPORTS,
  CAPABILITY_NAMES,
  ProviderDescriptorError,
  descriptorError,
  validateProviderDescriptor,
  __private: { KNOWN_SNAPSHOT_KINDS, normalizeText, isPlainObject }
};
