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
// 能力 `acp`（ACP 会话入口）只做**能力登记**：入口参数与传输形态的唯一数据源是
// lib/runtime/acp-layouts.js 的布局表；描述符在这里回答「本 provider 是否登记 ACP」，
// 让注册表能倒排。三份集合（描述符 / 布局表 / Go 合同 acp_session）的同源不变量
// 由 test/design-pattern-guard.test.js 守卫。

const { USAGE_SNAPSHOT_KINDS } = require('../account/usage-remaining');

const PROVIDER_DESCRIPTOR_CONTRACT_VERSION = 1;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const QUOTA_TRANSPORTS = Object.freeze(['http', 'client-cli', 'client-desktop']);
const QUOTA_SNAPSHOT_SHAPES = Object.freeze(['entries', 'models']);
const QUOTA_ENTRY_SHAPES = Object.freeze(['window', 'bucket', 'models']);
const RELAY_TRANSPORTS = Object.freeze(['http', 'client-cli', 'none']);
// relay 凭据形态白名单：新增一种必须先登记（写错立刻被拒，不静默丢弃）。
// relay.auth.kind 决定**推理请求的鉴权头形态**（策略模式：kind 是键，实现在
// lib/server/relay-auth-headers.js）。新增形态 = 加一个 kind + 一个实现，
// 不在共享传输文件里写 `if (provider === '...')`。
//   business_token       —— 单头：Authorization: Bearer <解析出的凭据>
//   business_token_pair  —— 双头：Authorization: Bearer <区域 access_token>
//                           + <extraHeader>: Bearer <长期 jwt>（zcode ultra 端点）
const RELAY_AUTH_KINDS = Object.freeze(['business_token', 'business_token_pair']);

// relay.pacing：**账号级并发/频率阀门**（所有 relay 共用，默认关闭）。
// 上游对「同一账号同时/连续发多少请求」的态度各不相同（在飞数上限 / 短时间重复即风控），
// 这是账号级运行约束而不是 provider 语义，因此声明成数据、状态机在
// lib/server/account-pacing.js（策略表按 kind 查，新增策略零改派发）。
// 白名单化：写错立刻被拒，不静默丢弃。
const RELAY_PACING_KINDS = Object.freeze(['account-window']);
const RELAY_PACING_SCOPES = Object.freeze(['account', 'account-model']);
const RELAY_PACING_ON_LIMIT = Object.freeze(['queue', 'reject']);
// 模型命名空间前缀（providerModelPrefix.aliases）的合法形状：与 provider id 同一套
// 命名空间字符集（小写字母开头、字母数字与中划线）。前缀会与模型 id 拼成 `<prefix>/<id>`，
// 形状不合法的前缀不可能出现在任何模型 id 里，因此在描述符加载时就拒掉。
const MODEL_PREFIX_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const CAPABILITY_NAMES = Object.freeze(['quota', 'models', 'usage', 'relay', 'authSources', 'hooks', 'acp', 'egress', 'activity', 'providerModelPrefix']);

// 账号活动动作的**参数词汇表**。参数是抽象槽位：计划任务与调度器只认 type，
// 不认识 `accountRefs` / `planKind` 这些 key 的语义 —— 语义由类型适配器实现
// （lib/account/activity-claim/params.js），这样新增 provider 不用改调度器。
//   account-refs —— 账号引用列表（string[]）；空数组 = 不筛（全部账号）
//   enum         —— 枚举取值；取值来自 options 或 optionsFrom:'kinds'
//   string       —— 自由文本
//   boolean      —— 开关
const ACTIVITY_PARAM_TYPES = Object.freeze(['account-refs', 'enum', 'string', 'boolean']);
// 空值语义：all = 空表示「全部」，any = 空表示「不限」。默认 any。
const ACTIVITY_PARAM_EMPTY_MEANS = Object.freeze(['all', 'any']);
const ACTIVITY_PARAM_OPTIONS_FROM = Object.freeze(['kinds']);
// plan 分类谓词：规则是数据，求值器在 lib/account/activity-claim/plans.js。
// 先按 plan_id 判（营销投放只下发 plan_id，没有 name），name 只作辅助。
const ACTIVITY_KIND_PREDICATES = Object.freeze(['planIdPrefix', 'planIdSuffix', 'planIdContains', 'nameContains']);
// action 层的合法字段集：**未知字段直接拒绝**。静默丢弃的后果是「params 打成
// param → 参数整段消失 → 定时任务静默退化成全账号领取」，比插件兼容更危险。
const ACTIVITY_ACTION_FIELDS = Object.freeze([
  'id', 'label', 'handler', 'description', 'schedulable', 'scheduleDebounceMs',
  'supportsProbe', 'params', 'kinds'
]);
const ACTIVITY_PARAM_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
// 类型 id 用 snake_case（weekend_build / start_plan）：它会作为枚举值存进任务参数，
// 大小写混排容易在 UI 与日志里读错。
const ACTIVITY_KIND_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const ACTIVITY_MAX_PARAMS = 8;
const ACTIVITY_MAX_KINDS = 16;

// 账号出口（代理）地址的 scheme 全集：网关（undici + socks5-connector）、Go Core、CLI 环境变量、
// Chromium 都能承载。描述符的 `egress.proxySchemes` 只能**收窄**到它的子集（原生消费方做不到的
// 写在自己的描述符里），不声明 = 全集。
const EGRESS_PROXY_SCHEMES = Object.freeze(['http:', 'https:', 'socks5:', 'socks5h:']);
// 认证来源的两条轴：来源形态（本机登录态 / 需要交互）与它依赖的客户端形态。
const AUTH_SOURCE_KINDS = Object.freeze(['local', 'remote']);
const AUTH_SOURCE_APPS = Object.freeze(['desktop', 'cli']);
// 来源的**执行方式**词汇表（与契约 authOptions 一样是数据，不是代码分支）：
//   device-code      —— 设备码授权任务（kiro）
//   social-device-code—— social（Google/GitHub）设备码授权任务（kiro）
//   paste-token      —— 用户粘贴 refresh_token（kiro）
//   host-account-scan—— 本机登录态由既有「扫描本机账号」整批入库（codebuddy 家族 / cline）
const AUTH_SOURCE_HANDLERS = Object.freeze(['device-code', 'social-device-code', 'paste-token', 'host-account-scan']);

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
  // relay 的**凭据形态**声明：有些 provider 的登录态凭据不能直接用于推理，
  // 必须先换成业务 token（例：zcode 的 OAuth access_token → POST 业务登录端点换 PAT）。
  // 声明成数据，消费方按能力倒排取解析器，不写 provider 名分支。
  // 形状：{ kind: 'business_token', loginUrl }
  let auth = null;
  if (relay.auth !== undefined && relay.auth !== null) {
    if (!isPlainObject(relay.auth)) throw descriptorError('provider_descriptor_relay_auth_invalid', id);
    const kind = normalizeText(relay.auth.kind);
    if (!RELAY_AUTH_KINDS.includes(kind)) throw descriptorError('provider_descriptor_relay_auth_kind_invalid', kind);
    const loginUrl = normalizeText(relay.auth.loginUrl);
    if (kind === 'business_token' && !/^https:\/\//.test(loginUrl)) {
      throw descriptorError('provider_descriptor_relay_auth_login_url_invalid', loginUrl);
    }
    // jwtPlanKinds：这些套餐类型直接用长期 jwt 作推理凭据，不做换取
    // （逆向桌面端：planKind==='start-plan' 时 apiKey = zcodeJwtToken）。
    const jwtPlanKinds = Array.isArray(relay.auth.jwtPlanKinds)
      ? relay.auth.jwtPlanKinds.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    // business_token_pair 专用：第二个头的名字与它的 token 取自账号的哪个字段。
    // 声明成数据，消费方按 kind 取用，不认 provider 名。
    const extraHeader = normalizeText(relay.auth.extraHeader);
    const extraTokenField = normalizeText(relay.auth.extraTokenField);
    // requestVerification：该 provider 的某些套餐在**模型请求**上还需要额外的
    // 请求验证参数（例：zcode start-plan 需要阿里云无痕验证头，缺则上游 3012）。
    // 声明成数据，由 request-verification-provider 按能力倒排消费。
    let requestVerification = null;
    if (relay.auth.requestVerification !== undefined && relay.auth.requestVerification !== null) {
      const rv = relay.auth.requestVerification;
      if (!isPlainObject(rv)) throw descriptorError('provider_descriptor_relay_auth_verification_invalid', id);
      const configUrl = normalizeText(rv.configUrl);
      if (!/^https:\/\//.test(configUrl)) {
        throw descriptorError('provider_descriptor_relay_auth_verification_config_url_invalid', configUrl);
      }
      const rvPlanKinds = Array.isArray(rv.planKinds)
        ? rv.planKinds.map((item) => normalizeText(item)).filter(Boolean)
        : [];
      requestVerification = Object.freeze({ planKinds: Object.freeze(rvPlanKinds), configUrl });
    }
    if (kind === 'business_token_pair' && (!extraHeader || !extraTokenField)) {
      throw descriptorError('provider_descriptor_relay_auth_pair_fields_missing', id);
    }
    auth = Object.freeze({
      kind,
      loginUrl,
      jwtPlanKinds: Object.freeze(jwtPlanKinds),
      ...(extraHeader ? { extraHeader } : {}),
      ...(extraTokenField ? { extraTokenField } : {}),
      requestVerification
    });
  }
  // relay.pacing：账号级并发/频率阀门（可选，缺省 = 不限流）。形状与语义见
  // lib/server/account-pacing.js；这里只做白名单与「至少给一个限制」的强校验。
  let pacing = null;
  if (relay.pacing !== undefined && relay.pacing !== null) {
    if (!isPlainObject(relay.pacing)) throw descriptorError('provider_descriptor_relay_pacing_invalid', id);
    const kind = normalizeText(relay.pacing.kind);
    if (!RELAY_PACING_KINDS.includes(kind)) {
      throw descriptorError('provider_descriptor_relay_pacing_kind_invalid', kind);
    }
    const scope = normalizeText(relay.pacing.scope) || 'account';
    if (!RELAY_PACING_SCOPES.includes(scope)) {
      throw descriptorError('provider_descriptor_relay_pacing_scope_invalid', scope);
    }
    const onLimit = normalizeText(relay.pacing.onLimit) || 'queue';
    if (!RELAY_PACING_ON_LIMIT.includes(onLimit)) {
      throw descriptorError('provider_descriptor_relay_pacing_on_limit_invalid', onLimit);
    }
    const maxInFlight = Number(relay.pacing.maxInFlight) > 0 ? Math.floor(Number(relay.pacing.maxInFlight)) : 0;
    const minIntervalMs = Number(relay.pacing.minIntervalMs) > 0 ? Math.floor(Number(relay.pacing.minIntervalMs)) : 0;
    if (!maxInFlight && !minIntervalMs) {
      throw descriptorError('provider_descriptor_relay_pacing_limits_missing', id);
    }
    const maxWaitMs = Number(relay.pacing.maxWaitMs) > 0 ? Math.floor(Number(relay.pacing.maxWaitMs)) : 0;
    pacing = Object.freeze({
      kind,
      scope,
      maxInFlight,
      minIntervalMs,
      onLimit,
      ...(maxWaitMs ? { maxWaitMs } : {})
    });
  }
  return Object.freeze({
    transport,
    clientDependent,
    reason: normalizeText(relay.reason),
    strategy: normalizeText(relay.strategy),
    auth,
    pacing
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
      // 来源实现是否已把**完整投影**写进目标 runtime dir：true = 调用方可以不开登录任务直接注册
      // 账号（宿主登录态物化即如此）；需要身份核验/换 token 的来源为 false，必须走登录任务。
      directImport: Boolean(source.directImport),
      // 本机登录态的**指纹**（离线可比）：用来判断「这份登录态是不是已经在账号池里了」。
      // 与 capability.accountIdentity 必须同源（同一函数算出来的键才可比）。
      identity: typeof source.identity === 'function' ? source.identity : null,
      // 来源自报可用性：本机来源的真实信号是「凭据读得到」，不是「二进制装没装」
      // （装了桌面端没装 CLI 时，按二进制判定会误报不可用）。
      available: typeof source.available === 'function' ? source.available : null,
      // 自动扫描入库钩子（同步）：宿主登录态是完整投影的来源才声明；扫描检测器按它倒排出覆盖面，
      // 不维护 provider 名单。需要身份核验/换 token 的来源（kiro IDE）不声明。
      scan: typeof source.scan === 'function' ? source.scan : null,
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

/**
 * 校验「ACP 会话入口」能力：**只做登记**，不复制入口数据 —— 入口形态（子命令 / 根旗标 /
 * 外部适配器二进制）与传输（stdio-ndjson / http-sse）的唯一数据源是
 * `lib/runtime/acp-layouts.js` 的布局表；消费方问注册表倒排（`listProviders('acp')`）
 * 而不是维护 provider 名单。申报了就必须能解析出入口（守卫测试逐项断言）。
 */
function validateAcpCapability(id, acp) {
  if (!isPlainObject(acp)) throw descriptorError('provider_descriptor_acp_invalid', id);
  if (acp.supported === false) {
    const reason = normalizeText(acp.reason);
    if (!reason) throw descriptorError('provider_descriptor_acp_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (acp.supported !== true) throw descriptorError('provider_descriptor_acp_supported_flag_invalid', id);
  return Object.freeze({ supported: true });
}

// 官方上游的地区策略（egress.regionPolicy）：
//   hints          预置地区提示（只作提示，可被实测推翻），形状同上游规则：{ effect, match, note, source, asOf }
//   denySignatures 上游拒绝该地区时的响应特征（小写子串）；命中即判「该出口 × 该上游 被拒」
// 只作用于该 provider 的**官方**上游；第三方 base URL 的上游不继承（它们有自己的策略）。
function validateRegionPolicy(id, raw) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw descriptorError('provider_descriptor_egress_region_policy_invalid', id);
  const hints = (Array.isArray(raw.hints) ? raw.hints : []).map((hint) => {
    if (!isPlainObject(hint) || !isPlainObject(hint.match)) throw descriptorError('provider_descriptor_egress_hint_invalid', id);
    if (!normalizeText(hint.source) || !normalizeText(hint.asOf)) {
      // 提示必须写明出处与日期：它会过时，UI 要能告诉用户「这条是哪天、依据什么写的」。
      throw descriptorError('provider_descriptor_egress_hint_source_missing', id);
    }
    return Object.freeze({
      effect: hint.effect === 'allow' ? 'allow' : 'deny',
      match: Object.freeze({ ...hint.match }),
      note: normalizeText(hint.note),
      source: normalizeText(hint.source),
      asOf: normalizeText(hint.asOf)
    });
  });
  const denySignatures = [...new Set((Array.isArray(raw.denySignatures) ? raw.denySignatures : [])
    .map((signature) => normalizeText(signature).toLowerCase()).filter(Boolean))];
  return Object.freeze({ hints: Object.freeze(hints), denySignatures: Object.freeze(denySignatures) });
}

/**
 * 校验「账号出口」能力：provider 的原生出口消费方能承载哪些代理 scheme。
 * 只允许收窄（非空、是 EGRESS_PROXY_SCHEMES 的子集），且必须写 reason —— 收窄意味着
 * 用户能填的地址变少，原因要能被追溯（与 quota.reason / clientFreeReason 同一纪律）。
 */
function validateEgressCapability(id, egress) {
  if (!isPlainObject(egress)) throw descriptorError('provider_descriptor_egress_invalid', id);
  const regionPolicy = validateRegionPolicy(id, egress.regionPolicy);
  const declaresSchemes = egress.proxySchemes !== undefined;
  const schemes = Array.isArray(egress.proxySchemes)
    ? [...new Set(egress.proxySchemes.map((scheme) => normalizeText(scheme).toLowerCase()))]
    : [];
  // proxySchemes 只用来**收窄**；不声明 = 全集。只声明地区策略的 provider 不必写它。
  if (!declaresSchemes && !regionPolicy) throw descriptorError('provider_descriptor_egress_schemes_empty', id);
  if (declaresSchemes) {
    if (schemes.length === 0) throw descriptorError('provider_descriptor_egress_schemes_empty', id);
    const unknown = schemes.find((scheme) => !EGRESS_PROXY_SCHEMES.includes(scheme));
    if (unknown) throw descriptorError('provider_descriptor_egress_scheme_invalid', unknown);
    const reason = normalizeText(egress.reason);
    if (!reason) throw descriptorError('provider_descriptor_egress_reason_missing', id);
    return Object.freeze({ proxySchemes: Object.freeze(schemes), reason, ...(regionPolicy ? { regionPolicy } : {}) });
  }
  return Object.freeze({ regionPolicy });
}

/**
 * 校验「账号活动 / 福利领取」能力：provider 自己声明它有哪些可自动执行的活动动作。
 *
 * 为什么是能力而不是命令层分支：签到、试用套餐这类动作是 provider 私有的（接口、验证码、
 * 窗口期都不同），把 provider 名写进命令层或 WebUI 就是又一张需要同步维护的名单。
 * 这里只声明「动作 id + 文案 + handler」，实现由组合根注册（与 model-discovery 的
 * `handler` 词汇表同一形态）：新增 provider = 加一段描述符，派发代码不动。
 *
 * 不变量：
 *   * `supported:false` 必须写 reason（与 quota 同一条纪律，禁止「没想过」）；
 *   * `supported:true` 必须有至少一个动作，动作 id 在 provider 内唯一；
 *   * 每个动作必须声明 label（UI 直接渲染）与 handler（宿主按 id 查实现，未知即 fail-closed）。
 */
function validateActivityKinds(id, actionId, rawKinds) {
  if (rawKinds === undefined) return null;
  if (!Array.isArray(rawKinds) || rawKinds.length === 0 || rawKinds.length > ACTIVITY_MAX_KINDS) {
    throw descriptorError('provider_descriptor_activity_kinds_invalid', `${id}:${actionId}`);
  }
  const seen = new Set();
  const kinds = rawKinds.map((kind) => {
    if (!isPlainObject(kind)) throw descriptorError('provider_descriptor_activity_kinds_invalid', `${id}:${actionId}`);
    const kindId = normalizeText(kind.id);
    if (!ACTIVITY_KIND_ID_PATTERN.test(kindId)) {
      throw descriptorError('provider_descriptor_activity_kind_id_invalid', `${id}:${actionId}:${kindId || 'empty'}`);
    }
    if (seen.has(kindId)) {
      throw descriptorError('provider_descriptor_activity_kind_duplicate', `${id}:${actionId}:${kindId}`);
    }
    seen.add(kindId);
    const label = normalizeText(kind.label);
    if (!label) throw descriptorError('provider_descriptor_activity_kind_label_missing', `${id}:${actionId}:${kindId}`);
    if (!isPlainObject(kind.when)) {
      throw descriptorError('provider_descriptor_activity_kind_when_invalid', `${id}:${actionId}:${kindId}`);
    }
    const entries = Object.entries(kind.when);
    if (entries.length === 0) {
      throw descriptorError('provider_descriptor_activity_kind_when_invalid', `${id}:${actionId}:${kindId}`);
    }
    const when = {};
    for (const [predicate, expected] of entries) {
      if (!ACTIVITY_KIND_PREDICATES.includes(predicate)) {
        throw descriptorError('provider_descriptor_activity_kind_predicate_unknown', `${id}:${actionId}:${predicate}`);
      }
      const value = normalizeText(expected);
      if (!value) {
        throw descriptorError('provider_descriptor_activity_kind_when_invalid', `${id}:${actionId}:${predicate}`);
      }
      when[predicate] = value;
    }
    return Object.freeze({
      id: kindId,
      label,
      description: normalizeText(kind.description),
      when: Object.freeze(when)
    });
  });
  return Object.freeze(kinds);
}

function validateActivityParams(id, actionId, rawParams, kinds) {
  if (rawParams === undefined) return null;
  if (!Array.isArray(rawParams) || rawParams.length > ACTIVITY_MAX_PARAMS) {
    throw descriptorError('provider_descriptor_activity_params_invalid', `${id}:${actionId}`);
  }
  const seen = new Set();
  const params = rawParams.map((field) => {
    if (!isPlainObject(field)) throw descriptorError('provider_descriptor_activity_params_invalid', `${id}:${actionId}`);
    const key = normalizeText(field.key);
    if (!ACTIVITY_PARAM_KEY_PATTERN.test(key)) {
      throw descriptorError('provider_descriptor_activity_param_key_invalid', `${id}:${actionId}:${key || 'empty'}`);
    }
    if (seen.has(key)) {
      throw descriptorError('provider_descriptor_activity_param_duplicate', `${id}:${actionId}:${key}`);
    }
    seen.add(key);
    const label = normalizeText(field.label);
    if (!label) throw descriptorError('provider_descriptor_activity_param_label_missing', `${id}:${actionId}:${key}`);
    const type = normalizeText(field.type).toLowerCase();
    if (!ACTIVITY_PARAM_TYPES.includes(type)) {
      throw descriptorError('provider_descriptor_activity_param_type_unknown', `${id}:${actionId}:${type || 'empty'}`);
    }
    const emptyMeansRaw = normalizeText(field.emptyMeans).toLowerCase();
    const emptyMeans = emptyMeansRaw || 'any';
    if (!ACTIVITY_PARAM_EMPTY_MEANS.includes(emptyMeans)) {
      throw descriptorError('provider_descriptor_activity_param_empty_means_invalid', `${id}:${actionId}:${key}`);
    }
    const optionsFrom = normalizeText(field.optionsFrom);
    if (optionsFrom) {
      if (!ACTIVITY_PARAM_OPTIONS_FROM.includes(optionsFrom) || type !== 'enum') {
        throw descriptorError('provider_descriptor_activity_param_options_from_invalid', `${id}:${actionId}:${key}`);
      }
      if (optionsFrom === 'kinds' && (!kinds || kinds.length === 0)) {
        throw descriptorError('provider_descriptor_activity_kind_ref_missing', `${id}:${actionId}:${key}`);
      }
    }
    let options = null;
    if (field.options !== undefined) {
      if (type !== 'enum' || !Array.isArray(field.options) || field.options.length === 0) {
        throw descriptorError('provider_descriptor_activity_param_options_invalid', `${id}:${actionId}:${key}`);
      }
      const seenValues = new Set();
      options = field.options.map((option) => {
        if (!isPlainObject(option)) {
          throw descriptorError('provider_descriptor_activity_param_options_invalid', `${id}:${actionId}:${key}`);
        }
        const value = normalizeText(option.value);
        if (!value || seenValues.has(value)) {
          throw descriptorError('provider_descriptor_activity_param_options_invalid', `${id}:${actionId}:${key}`);
        }
        seenValues.add(value);
        return Object.freeze({
          value,
          label: normalizeText(option.label) || value,
          description: normalizeText(option.description)
        });
      });
    }
    // enum 必须有取值来源：要么声明 options，要么引用 kinds。两样都没有的枚举
    // 在 UI 上是一个空下拉框，保存下来的值永远校验不过 —— 当场拒掉。
    if (type === 'enum' && !options && !optionsFrom) {
      throw descriptorError('provider_descriptor_activity_param_options_invalid', `${id}:${actionId}:${key}`);
    }
    const maxItemsRaw = Number(field.maxItems);
    const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? Math.floor(maxItemsRaw) : 0;
    return Object.freeze({
      key,
      label,
      type,
      description: normalizeText(field.description),
      required: field.required === true,
      emptyMeans,
      ...(maxItems > 0 ? { maxItems } : {}),
      ...(options ? { options: Object.freeze(options) } : {}),
      ...(optionsFrom ? { optionsFrom } : {})
    });
  });
  return Object.freeze(params);
}

function validateActivityCapability(id, activity) {
  if (!isPlainObject(activity)) throw descriptorError('provider_descriptor_activity_invalid', id);
  if (activity.supported === false) {
    const reason = normalizeText(activity.reason);
    if (!reason) throw descriptorError('provider_descriptor_activity_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (activity.supported !== true) throw descriptorError('provider_descriptor_activity_supported_flag_invalid', id);
  const rawActions = Array.isArray(activity.actions) ? activity.actions : [];
  if (rawActions.length === 0) throw descriptorError('provider_descriptor_activity_actions_empty', id);
  const seen = new Set();
  const actions = rawActions.map((action) => {
    if (!isPlainObject(action)) throw descriptorError('provider_descriptor_activity_action_invalid', id);
    const actionId = normalizeText(action.id).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(actionId)) {
      throw descriptorError('provider_descriptor_activity_action_id_invalid', actionId || id);
    }
    if (seen.has(actionId)) throw descriptorError('provider_descriptor_activity_action_duplicate', `${id}:${actionId}`);
    seen.add(actionId);
    const label = normalizeText(action.label);
    if (!label) throw descriptorError('provider_descriptor_activity_action_label_missing', `${id}:${actionId}`);
    const handler = normalizeText(action.handler);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(handler)) {
      throw descriptorError('provider_descriptor_activity_action_handler_invalid', `${id}:${actionId}`);
    }
    // `schedulable`：该动作**对外提供定时调度**（计划任务菜单据此列出可选事件）。
    // 这是**能力声明**，不是调度器里的硬编码：新增 provider/动作只改描述符，
    // 计划任务下拉框自动跟着变；未声明 = 不可调度（保守，不给不该定时跑的动作用户入口）。
    // `scheduleDebounceMs`：同一事件的两次触发在这个窗口内只执行一次（防抖/去重），
    // 由描述符按动作语义给出（领取类动作重复执行会打上游）。
    const schedulable = action.schedulable === true;
    const debounceRaw = Number(action.scheduleDebounceMs);
    const scheduleDebounceMs = Number.isFinite(debounceRaw) && debounceRaw > 0
      ? Math.floor(debounceRaw)
      : 0;
    const unknownField = Object.keys(action).find((key) => !ACTIVITY_ACTION_FIELDS.includes(key));
    if (unknownField) {
      throw descriptorError('provider_descriptor_activity_action_field_unknown', `${id}:${actionId}:${unknownField}`);
    }
    // 分类规则先于参数校验：`optionsFrom:'kinds'` 的合法性要引用 kinds。
    const kinds = validateActivityKinds(id, actionId, action.kinds);
    const params = validateActivityParams(id, actionId, action.params, kinds);
    // `supportsProbe`：该动作提供**只读探测**（先看有什么可领，再决定领什么）。
    // 只读探测与领取共用同一个 handler 的 dryRun 分支，不新增第二个 handler。
    const supportsProbe = action.supportsProbe === true;
    return Object.freeze({
      id: actionId,
      label,
      handler,
      description: normalizeText(action.description),
      schedulable,
      ...(schedulable && scheduleDebounceMs > 0 ? { scheduleDebounceMs } : {}),
      ...(supportsProbe ? { supportsProbe: true } : {}),
      ...(params ? { params } : {}),
      ...(kinds ? { kinds } : {})
    });
  });
  return Object.freeze({ supported: true, actions: Object.freeze(actions) });
}

/**
 * 校验「模型命名空间前缀」能力（`providerModelPrefix`）：provider 自己声明
 * 「`<provider>/<model>` 这种带前缀的模型 id 请求应当被解析成本 provider 的模型」。
 *
 * 动机（2026-10-25 真机）：模型目录里登记的是**裸** id（zcode 的 `glm-5.3`），而网关请求
 * 用带 provider 前缀的写法（`zcode/glm-5.3`）。前缀写法在选号器里既匹配不上账号目录、
 * 也匹配不上倒排索引，于是被当成「目录已知且不含该模型」的强否定证据，整个池被排空 →
 * 503 no_available_account。
 *
 * 为什么是**声明**而不是全局剥离：裸 id 常常被多个 provider 同时持有（实测 `glm-5.3`
 * 同时挂在 zcode / codebuddy / workbuddy / workbuddycn 名下），全局剥离等于把
 * 「钉住哪个 provider」这层语义丢掉，会让请求漂移到别家的池子。因此前缀只在
 * **provider 显式声明**时生效，且解析结果同时**锁定该 provider**。
 *
 * 与 opencode 既有前缀逻辑的关系：`opencode/`、`opencode-go/`、`zen/`、`go/` 是
 * `lib/server/opencode-server-client.js` 里的传输层特例（它们剥前缀是为了拼上游
 * `providerID/modelID` 对），本能力**不替代也不改变**它们 —— 未声明的 provider 行为
 * 逐字节不变。本能力回答的是选号层的问题：前缀 id 该归谁、对应哪个目录 id。
 *
 * 形状：`{ supported: true, aliases: ['<extra prefix>', ...] }`
 *   * `aliases` 是**额外**接受的前缀（provider id 本身总是接受），用于同一个 provider
 *     在历史/上游有多个名字的情况（如 zcode 的 `zai`）。空数组合法。
 *   * 前缀必须是合法命名空间形状（小写字母数字与中划线），写错立刻被拒而不是静默失效。
 *   * 不声明该能力的 provider = 不支持前缀写法，行为完全不变（向后兼容）。
 */
function validateProviderModelPrefixCapability(id, value) {
  if (!isPlainObject(value)) throw descriptorError('provider_descriptor_provider_model_prefix_invalid', id);
  if (value.supported === false) {
    // 与 quota 同一条纪律：显式回答「不支持」，而不是靠字段缺席表达。
    const reason = normalizeText(value.reason);
    if (!reason) throw descriptorError('provider_descriptor_provider_model_prefix_reason_missing', id);
    return Object.freeze({ supported: false, reason });
  }
  if (value.supported !== true) {
    throw descriptorError('provider_descriptor_provider_model_prefix_supported_flag_invalid', id);
  }
  const rawAliases = Array.isArray(value.aliases) ? value.aliases : [];
  const seen = new Set();
  const aliases = [];
  for (const raw of rawAliases) {
    const alias = normalizeText(raw).toLowerCase();
    if (!MODEL_PREFIX_ALIAS_PATTERN.test(alias)) {
      throw descriptorError('provider_descriptor_provider_model_prefix_alias_invalid', `${id}:${alias || raw}`);
    }
    if (seen.has(alias)) {
      throw descriptorError('provider_descriptor_provider_model_prefix_alias_duplicate', `${id}:${alias}`);
    }
    seen.add(alias);
    aliases.push(alias);
  }
  return Object.freeze({ supported: true, aliases: Object.freeze(aliases) });
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
  if (capabilities.acp !== undefined) normalized.acp = validateAcpCapability(id, capabilities.acp);
  if (capabilities.egress !== undefined) normalized.egress = validateEgressCapability(id, capabilities.egress);
  if (capabilities.activity !== undefined) {
    normalized.activity = validateActivityCapability(id, capabilities.activity);
  }
  if (capabilities.providerModelPrefix !== undefined) {
    normalized.providerModelPrefix = validateProviderModelPrefixCapability(id, capabilities.providerModelPrefix);
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
  RELAY_PACING_KINDS,
  RELAY_PACING_ON_LIMIT,
  RELAY_PACING_SCOPES,
  CAPABILITY_NAMES,
  EGRESS_PROXY_SCHEMES,
  ProviderDescriptorError,
  descriptorError,
  validateProviderDescriptor,
  __private: { KNOWN_SNAPSHOT_KINDS, normalizeText, isPlainObject }
};
