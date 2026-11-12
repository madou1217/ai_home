'use strict';

const crypto = require('node:crypto');
const { readGoCoreBindField } = require('./go-core-bind');
const { listWildcardAliasModels } = require('./wildcard-alias-expansion');
const { createGoCoreSupervisor } = require('../cli/services/server/go-core-supervisor');
const { createGoCoreGatewayForwarder } = require('./go-core-gateway-forwarder');
const { createNodeFallbackCounters } = require('./go-core-node-fallback-counters');
const { createGoAccountSync } = require('./go-account-sync');
const { createGoManagementClient } = require('../account/go-bridge/go-management-client');
const {
  collectAccountUpstreamErrorRuleRecords,
  listUnacceptedEnabledRuleAccounts
} = require('./upstream-error-rules-projection');
const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { normalizeUpstreamErrorRuleProviders } = require('./server-config-store');
const {
  compileRouteTable,
  loadRouteOwnershipManifest,
  parseEntryIdList,
  resolveEffectiveGoOwnership
} = require('./go-core-route-ownership');

// 只按「步骤:错误码」聚合计数，不打印账号凭据；排查时一眼看出是哪一类失败。
function summarizeSyncErrors(errors) {
  if (!errors.length) return '';
  const counts = new Map();
  for (const entry of errors) {
    const key = `${entry.step || '?'}:${entry.error || 'unknown'}${entry.cached ? '(cached)' : ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return ` (${[...counts].map(([key, count]) => `${key}×${count}`).join(', ')})`;
}

// Node 宿主版本：插件 engines.aih 的判定依据（与 plugin-system 的 hostVersionOf 同源）。
function hostVersionOf() {
  try { return String(require('../../package.json').version || '1.0.0'); } catch (_error) { return '1.0.0'; }
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function hasEnv(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) && String(env[name]).trim() !== '';
}

/** 持久化 server config 是事实来源；AIH_GO_CORE_* 环境变量仅作开发期覆盖。 */
function resolveGoCoreSettings(config = {}, env = {}) {
  // 规则承接名单的 env 判定必须看「变量是否存在」而不是「是否非空」：Go 侧把显式空值读成
  // 关闭，若这里把空值当未声明就会回落到 config，让 Node 与 Go 对同一份环境得出不同结论。
  const rulesDeclaredByHost = Object.prototype.hasOwnProperty.call(env, 'AIH_SERVER_UPSTREAM_ERROR_RULES');
  return {
    enabled: hasEnv(env, 'AIH_GO_CORE_ENABLED') ? isTruthy(env.AIH_GO_CORE_ENABLED) : config.goCoreEnabled === true,
    routes: parseEntryIdList(hasEnv(env, 'AIH_GO_CORE_ROUTES') ? env.AIH_GO_CORE_ROUTES : config.goCoreRoutes),
    upstreamErrorRuleProviders: normalizeUpstreamErrorRuleProviders(
      rulesDeclaredByHost ? env.AIH_SERVER_UPSTREAM_ERROR_RULES : config.upstreamErrorRuleProviders
    ),
    binaryPath: hasEnv(env, 'AIH_GO_CORE_BINARY') ? String(env.AIH_GO_CORE_BINARY).trim() : undefined,
    host: readGoCoreBindField(env, 'host'),
    port: Number.isFinite(readGoCoreBindField(env, 'port')) ? readGoCoreBindField(env, 'port') : undefined,
    managementKey: hasEnv(env, 'AIH_GO_CORE_MANAGEMENT_KEY') ? String(env.AIH_GO_CORE_MANAGEMENT_KEY).trim() : '',
    // 账号双向同步默认随 Go Core 开启：没有它 Go 的 aih.db 与 Node 的 app-state.db 会分叉。
    accountSync: hasEnv(env, 'AIH_GO_CORE_ACCOUNT_SYNC') ? isTruthy(env.AIH_GO_CORE_ACCOUNT_SYNC) : true,
    // 默认随账号同步：同步在跑时 Node 是唯一刷新者。隔离测试（关同步、读真实凭据快照）
    // 必须显式打开，否则 Go 会轮换真实 Refresh Token、让生产那份作废。
    delegateCredentialRefresh: hasEnv(env, 'AIH_GO_CORE_DELEGATE_REFRESH')
      ? isTruthy(env.AIH_GO_CORE_DELEGATE_REFRESH)
      : undefined,
    clientKey: hasEnv(env, 'AIH_GO_CORE_CLIENT_KEY') ? String(env.AIH_GO_CORE_CLIENT_KEY).trim() : ''
  };
}

function generateBootKey() {
  return crypto.randomBytes(32).toString('base64url');
}

// 两侧账号引用的翻译是**纯函数**：同步链接存在时按链接走，没有链接时按恒等。
//
// 「没有链接」不等于「未映射」：两边引用本来就是同一份内容寻址 hash，只是这个账号还没
// 走进链接表（新导入 / 同步被跳过）。返回空串会让调用方把同一个账号判成未映射——实测
// opencode 的 API Key 账号因此读不到 Go 的 account_models（WebUI 显示 0 个模型）。
function translateNodeRefToGo(nodeRef, links) {
  const normalized = String(nodeRef || '').trim();
  if (!normalized) return '';
  const linked = links && links[normalized] && links[normalized].goRef;
  return linked ? String(linked) : normalized;
}

// 管理 API 的 ref：调用方一律传 Node ref，这里统一翻译成 Go ref。
// 翻译失败（空结果）时按恒等回落；空 ref 返回空串，由调用方报明确错误。
function managementGoRef(nodeRef, resolveGoRef) {
  const normalized = String(nodeRef || '').trim();
  if (!normalized) return '';
  const resolved = typeof resolveGoRef === 'function' ? resolveGoRef(normalized) : '';
  return String(resolved || '').trim() || normalized;
}

// token 用量窗口的时区偏移（分钟）。
//
// 为什么用固定偏移而不是 IANA 时区名：Node 侧唯一可移植的来源是
// Date#getTimezoneOffset()，它没有时区名可给；而 IANA 需要 tzdata（精简镜像里可能缺失）。
// 两个 API 的符号相反：getTimezoneOffset() 返回「UTC − 本地」（UTC+8 得 -480），
// Go 的 tz_offset_minutes 要「本地 − UTC」（UTC+8 = 480）。所以这里统一成后者：
// 缺省值取反一次；调用方显式传入的也按同一语义解释，不再二次取反。
// 0 是合法值（UTC），不能用真值判断把它当成「没传」。
function resolveTokenUsageTZOffset(value) {
  const fallback = new Date().getTimezoneOffset() * -1;
  if (value === undefined || value === null || value === '') return fallback;
  const minutes = Number(value);
  return Number.isInteger(minutes) ? minutes : fallback;
}

function translateGoRefToNode(goRef, links) {
  const normalized = String(goRef || '').trim();
  if (!normalized) return '';
  for (const [nodeRef, link] of Object.entries(links && typeof links === 'object' ? links : {})) {
    if (String(link && link.goRef || '').trim() === normalized) return nodeRef;
  }
  return normalized;
}

/**
 * Go Core 在 Node 公开宿主进程内的组合根（Facade）：监督 Go 子进程的完整生命周期，
 * 并按 route-ownership manifest 把已划给 Go 的数据面请求透明转发过去。
 * 监督器必须活在长驻 Server 进程里——活在短命 CLI 进程里时，CLI 退出后 Go 无人监督。
 */
function createGoCoreHost(deps = {}) {
  const settings = deps.settings || resolveGoCoreSettings();
  const log = deps.log || console;
  // manifest 是随代码发布的合同文件，始终从真实文件系统读取（不受注入的 fs 替身影响）。
  const manifest = deps.manifest || loadRouteOwnershipManifest({ repositoryRoot: deps.repositoryRoot });
  const ownership = resolveEffectiveGoOwnership(manifest, settings.routes, settings.enabled);
  const managementKey = settings.managementKey || generateBootKey();
  const clientKey = settings.clientKey || generateBootKey();
  const buildSupervisor = deps.createGoCoreSupervisor || createGoCoreSupervisor;
  const supervisor = buildSupervisor({
    enabled: settings.enabled,
    fs: deps.fs,
    path: deps.path,
    spawn: deps.spawn,
    fetchImpl: deps.fetchImpl,
    processObj: deps.processObj,
    // Go 子进程的环境覆盖项（目前是与 Node 对齐的出站代理，见 go-core-proxy-guard）。
    env: deps.childEnvironment,
    repositoryRoot: deps.repositoryRoot,
    binaryPath: settings.binaryPath,
    host: settings.host,
    port: settings.port,
    publicPort: deps.publicPort,
    aiHomeDir: deps.aiHomeDir,
    managementKey: () => managementKey,
    clientKey: () => clientKey,
    // 账号同步把 Node 刷新后的凭据推给 Go，因此 Go 不再自行刷新（单一刷新者）。
    delegateCredentialRefresh: settings.delegateCredentialRefresh === undefined
      ? settings.accountSync
      : settings.delegateCredentialRefresh,
    // 规则承接名单经环境变量投递给 Go（进程启动即定，无法运行期变更）。
    upstreamErrorRuleProviders: settings.upstreamErrorRuleProviders,
    onRestarted: (status) => handleRestarted(status)
  });

  let accountsSynced = !settings.accountSync;
  // Go 能路由的模型集合（来自 Go 自己的 /v1/models）。转发前判定用它把 Go 路由不了的模型
  // （只有 Node 承接的 Provider）交还 Node；未加载前为 null（判定保守交还 Node）。
  let routableModelIds = null;
  let routableModelOwners = null;
  let modelRefreshTimer = null;
  const modelRefreshIntervalMs = Number(deps.modelRefreshIntervalMs) || 30000;
  // Go 已确认接受的 Node 别名 id（其路由目录里已有等价规则）。命中这些别名的请求
  // 可以交给 Go；未确认的别名继续保守交还 Node（见 go-core-route-deferral）。
  let acceptedAliasIds = new Set();
  // 上次成功推送的别名表内容：未变化时不重复 PUT（每 30 秒的刷新会走这条路径）。
  let pushedAliasRevision = '';
  // 最近一次成功的别名投影握手结果，随 status()/readiness() 暴露给运维。
  let lastAliasPush = null;
  // Go 已承接的规则账号引用（Go 侧引用）：只有被承接的账号才由 Go 执行自定义错误规则，
  // 其余账号的请求必须继续交还 Node（见 go-core-route-deferral）。
  let acceptedErrorRuleRefs = new Set();
  // 上次成功推送的规则投影内容：未变化时不重复 PUT。
  let pushedRuleRevision = '';
  // 最近一次成功的规则投影握手结果，随 readiness() 暴露给运维。
  let lastRulesPush = null;
  let pushedModelCatalogRevision = '';
  let lastModelCatalogPush = null;

  function readSyncLinks() {
    const { readJsonValue } = require('./app-state-store');
    const { SYNC_STATE_KEY } = require('./go-account-sync');
    return (readJsonValue(deps.fs || require('node:fs'), deps.aiHomeDir, SYNC_STATE_KEY) || {}).links || {};
  }

  // Node→Go 账号 id 映射来自账号同步的链接表（未启用同步时两边 id 相同，按原样返回）。
  //
  // 没有链接时按**恒等**处理：两边引用本来就相同（同一份内容寻址 hash），只是这个账号
  // 还没走进同步链接表（新导入 / 同步被跳过）。返回空串会让调用方把「同一个账号」当成
  // 「未映射」——实测 opencode 的 API Key 账号因此读不到 Go 的 account_models。
  function goAccountRefFor(nodeRef) {
    const normalizedNodeRef = String(nodeRef || '').trim();
    if (!normalizedNodeRef) return '';
    if (!accountSync) return normalizedNodeRef;
    try {
      return translateNodeRefToGo(normalizedNodeRef, readSyncLinks());
    } catch (_error) {
      return normalizedNodeRef;
    }
  }

  // 整张 Node→Go 映射（一次读取，供批量投影）；未启用同步时返回 null 表示两边 id 相同。
  function goRefsByNodeRef() {
    if (!accountSync) return null;
    const result = {};
    for (const [nodeRef, link] of Object.entries(readSyncLinks())) {
      if (link && link.goRef) result[nodeRef] = String(link.goRef);
    }
    return result;
  }

  // 透传响应携带 Go 账号引用时，把它还原为 Node 凭据库的账号引用。
  // 同步 rekey/身份合并后两侧引用可能不同，恢复 OAuth 必须回到 Node 源账号。
  function nodeAccountRefFor(goRef) {
    const normalizedGoRef = String(goRef || '').trim();
    if (!normalizedGoRef) return '';
    if (!accountSync) return normalizedGoRef;
    try {
      return translateGoRefToNode(normalizedGoRef, readSyncLinks());
    } catch (_error) {
      return normalizedGoRef;
    }
  }

  async function refreshRoutableModels() {
    const client = managementClient();
    if (!client) return;
    try {
      const response = await client.getModelCatalog();
      const body = response && response.ok ? response.data : null;
      if (body && Array.isArray(body.routable_model_ids)) {
        routableModelIds = new Set(body.routable_model_ids.map((id) => String(id || '')).filter(Boolean));
        const ownerByID = new Map(
          (Array.isArray(body.models) ? body.models : [])
            .filter((item) => item && item.id)
            .map((item) => [String(item.id), String(item.owned_by || '')])
        );
        routableModelOwners = new Map(
          [...routableModelIds].map((id) => [id, ownerByID.get(id) || ''])
        );
      }
    } catch (_error) {
      // 保留上一份集合；Go 暂不可用时转发前判定本来就会交还 Node。
    }
  }

  function managementClient() {
    const status = supervisor.status();
    // supervisor 的 state 是「本次进程内拉起的 Go 子进程」状态；外部 launchd/独立进程
    // 已监听同一 loopback 端点时，不能因为没有自己的 child 就把管理面判成不可用。
    // 仍以 supervisor 的 endpoint 优先，其次回落到持久化的 host/port；请求失败由调用方
    // 按网络错误处理，不能把「已就绪的独立 Go」误报成 go_core_unavailable。
    const fallbackHost = String(settings.host || '127.0.0.1').trim() || '127.0.0.1';
    const fallbackPort = Number(settings.port || 19550);
    const fallbackEndpoint = Number.isInteger(fallbackPort) && fallbackPort > 0
      ? `http://${fallbackHost}:${fallbackPort}`
      : '';
    const endpoint = status.endpoint || (settings.enabled ? fallbackEndpoint : '');
    if (!endpoint) return null;
    return buildManagementClient({
      baseUrl: endpoint,
      managementKey,
      fetchImpl: deps.fetchImpl,
      hostVersion: deps.hostVersion || hostVersionOf(),
      nodeVersion: deps.nodeVersion || process.versions.node
    });
  }

  // Node 别名记录 → Go 投影记录：字段名与 Node normalizeAliasRecord 对齐，
  // enabled 显式下发，避免 Go 把缺省当停用。
  function aliasProjectionRecord(record) {
    const alias = String(record && record.alias || '');
    return {
      id: String(record && record.id || ''),
      alias,
      target: String(record && record.target || ''),
      provider: String(record && record.provider || ''),
      targetProvider: String(record && record.targetProvider || ''),
      priority: Number(record && record.priority) || 0,
      enabled: !record || record.enabled !== false,
      description: String(record && record.description || ''),
      // 通配别名的展示名单由 Node 按 models.dev 快照算好再推：Go 没有快照，两边列表必须同源。
      ...(alias.endsWith('*') ? { displayModels: listWildcardAliasModels(alias) } : {})
    };
  }

  /**
   * 把 Node 的模型别名表推给 Go，并记录 Go 接受的别名。
   *
   * 只有 applied_generation 追平 generation 时才更新接受集合：否则 Go 的路由目录
   * 还没反映这份别名，按「已接受」转发会让别名请求解析到错误目标。
   * 失败或未追平时保持上一份接受集合（空集合 = 全部保守交还 Node）。
   */
  async function pushModelAliases() {
    const client = managementClient();
    if (!client) return null;
    let records;
    try {
      const data = await loadAliases(deps.fs || require('node:fs'), deps.aiHomeDir);
      records = (data && Array.isArray(data.aliases) ? data.aliases : []).map(aliasProjectionRecord);
    } catch (_error) {
      return null;
    }
    const revision = JSON.stringify(records);
    if (revision === pushedAliasRevision) return { skipped: true };
    // 写入口已经在 Go 之后，Go 库里的别名才是权威事实：整体推送会把它覆盖成
    // Node 的旧副本（真机上探针别名就是这样被冲掉的）。只有 Go 还空着时才推，
    // 用来给全新环境播种；之后一律以 Go 为准。
    // 注意用的是 WebUI 契约的列表接口：/v1/management/model-aliases 的 GET 只回
    // accepted_ids 与代次，没有 aliases 字段——用它判断会永远得到「空」，等于没拦。
    if (typeof client.send === 'function') {
      const existing = await client
        .send({ method: 'GET', path: '/v1/management/webui/model-aliases' })
        .catch(() => null);
      const existingAliases = existing && existing.ok && existing.data
        ? (Array.isArray(existing.data.aliases) ? existing.data.aliases : [])
        : [];
      if (existingAliases.length > 0) {
        pushedAliasRevision = revision;
        lastAliasPush = {
          generation: Number(existing.data.generation) || 0,
          appliedGeneration: Number(existing.data.applied_generation) || 0,
          accepted: existingAliases.length,
          dropped: 0,
          source: 'go',
        };
        return { skipped: true, reason: 'go_owns_aliases' };
      }
    }
    const response = await client.pushModelAliases(records);
    const body = response && response.ok ? response.data : null;
    if (!body || Number(body.applied_generation) !== Number(body.generation)) return null;
    pushedAliasRevision = revision;
    acceptedAliasIds = new Set(
      (Array.isArray(body.accepted_ids) ? body.accepted_ids : []).map((id) => String(id))
    );
    const dropped = Array.isArray(body.dropped) ? body.dropped.length : 0;
    lastAliasPush = {
      generation: Number(body.generation) || 0,
      appliedGeneration: Number(body.applied_generation) || 0,
      accepted: acceptedAliasIds.size,
      dropped,
    };
    log.log(`\x1b[90m[aih:go-core]\x1b[0m model aliases: pushed=${records.length} accepted=${acceptedAliasIds.size} kept-on-node=${dropped}`);
    return body;
  }

  /**
   * Node 账号级规则来源：app-state 的账号凭据 env（AIH_UPSTREAM_ERROR_RULES /
   * AIH_UPSTREAM_ERROR_GROUP_IDS）。
   *
   * deps.accountRuleConfigs 允许宿主注入内存快照；没有注入时直接读 app-state.db，
   * 与 go-account-sync 的账号真相同源。
   */
  function readAccountRuleConfigs() {
    if (typeof deps.accountRuleConfigs === 'function') {
      const value = deps.accountRuleConfigs();
      if (Array.isArray(value)) return value;
      if (value && Array.isArray(value.accounts)) return value.accounts;
      return null;
    }
    const aiHomeDir = String(deps.aiHomeDir || '').trim();
    if (!aiHomeDir) return null;
    try {
      return readNodeAccounts(aiHomeDir, { fs: deps.fs }).accounts;
    } catch (_error) {
      return null;
    }
  }

  /**
   * 把账号级规则（账号自身规则 + 挂载组 id）推给 Go。
   *
   * 只推账号级配置（自身规则 + 挂载组 id）：组规则由 Go 按挂载顺序展开。每个账号一次
   * PUT，某个账号失败只影响它自己；推送前先读 Go 的现有引用，把 Node 已不存在的
   * 账号删掉，保证「清空规则」也能落到 Go。
   */
  async function pushUpstreamErrorRules(options = {}) {
    const client = managementClient();
    if (!client || typeof client.putAccountUpstreamErrorRules !== 'function') return null;
    const accounts = readAccountRuleConfigs();
    if (!accounts) return null;
    // 账号同步启用时 Go 路由的是它自己的账号引用，规则必须挂在 Go 引用上。
    // 推送与「哪些账号仍留在 Node」的判定必须用同一个映射，否则接受集合与交还清单会错位。
    const goRefFor = accountSync ? (ref) => goAccountRefFor(ref) : null;
    const pools = typeof deps.accountPools === 'function' ? deps.accountPools() : {};
    let collected;
    try {
      collected = collectAccountUpstreamErrorRuleRecords(accounts, { goRefFor });
    } catch (_error) {
      return null;
    }
    const records = collected.records;
    const revision = JSON.stringify(records);
    if (!options.force && revision === pushedRuleRevision) {
      return { skipped: true, ...(lastRulesPush || {}) };
    }

    // 先读 Go 现有引用：推完之后删除不在本次集合里的账号。
    const existing = typeof client.listAccountUpstreamErrorRules === 'function'
      ? await client.listAccountUpstreamErrorRules().catch(() => null)
      : null;
    const listOk = Boolean(existing && existing.ok);
    const existingData = existing && existing.ok && existing.data ? existing.data : null;
    const existingRefs = new Set(
      (existingData && Array.isArray(existingData.accounts) ? existingData.accounts : [])
        .map((item) => String(item && item.account_ref || '').trim())
        .filter(Boolean)
    );

    const accepted = new Set();
    const dropped = [];
    let failed = 0;
    for (const record of records) {
      const response = await client.putAccountUpstreamErrorRules(record.account_ref, {
        group_ids: record.group_ids,
        rules: record.rules
      }).catch(() => null);
      const data = response && response.ok ? response.data : null;
      if (!data) {
        failed += 1;
        dropped.push({ account_ref: record.account_ref, reason: (response && response.errorCode) || 'push_failed' });
        continue;
      }
      if (data.supported === false) {
        dropped.push({ account_ref: record.account_ref, reason: 'provider_not_supported' });
        continue;
      }
      accepted.add(record.account_ref);
    }

    const currentRefs = new Set(records.map((record) => record.account_ref));
    let deleteFailed = 0;
    for (const ref of existingRefs) {
      if (!ref || currentRefs.has(ref)) continue;
      const response = await client.deleteAccountUpstreamErrorRules(ref).catch(() => null);
      if (!response || response.ok !== true) deleteFailed += 1;
    }

    // 只有整轮都成功才记指纹：一次瞬时失败若也被记住，下一轮会因「内容未变」跳过，
    // 失败账号会一直留在 Node，而 Go 侧还可能保留已删账号的旧规则。
    if (failed === 0 && deleteFailed === 0 && listOk) pushedRuleRevision = revision;
    acceptedErrorRuleRefs = accepted;
    // 「开关打开了但流量仍然全在 Node」的唯一原因：运行池里还有 Go 未承接的规则账号。
    // 必须显式暴露，否则这个开关静默失效时无法从 /readyz 判断。
    const keptOnNodeAccounts = listUnacceptedEnabledRuleAccounts(pools, acceptedErrorRuleRefs, goRefFor);
    lastRulesPush = {
      generation: Number(existingData && existingData.generation) || 0,
      pushed: records.length,
      accepted: acceptedErrorRuleRefs.size,
      dropped: dropped.length,
      failed,
      deleteFailed,
      listFailed: !listOk,
      droppedReasons: [...new Set(dropped.map((item) => String(item && item.reason || '')))].filter(Boolean),
      skippedAccounts: collected.skipped,
      supportedProviders: existingData && Array.isArray(existingData.supported_providers)
        ? existingData.supported_providers.map((id) => String(id))
        : [],
      // 交还 Node 求值的账号（推理请求只要命中其中一个就会整体交还）。
      keptOnNodeAccounts
    };
    log.log(`\x1b[90m[aih:go-core]\x1b[0m upstream error rules: pushed=${records.length} accepted=${acceptedErrorRuleRefs.size} failed=${failed} delete-failed=${deleteFailed} kept-on-node=${dropped.length}`);
    if (keptOnNodeAccounts.length > 0) {
      const detail = keptOnNodeAccounts
        .map((item) => `${item.provider || '?'}:${item.accountRef || '?'}`)
        .join(', ');
      log.log(`\x1b[33m[aih:go-core]\x1b[0m upstream error rules: ${keptOnNodeAccounts.length} account(s) still on Node, every inference request is handed back to Node: ${detail}`);
    }
    return { ok: true, ...lastRulesPush };
  }

  async function pushModelCatalogProjection(payload) {
    const client = managementClient();
    if (!client || !payload || typeof payload !== 'object') return null;
    const revision = String(payload.revision || '').trim();
    if (!revision || revision === pushedModelCatalogRevision) return { skipped: true };
    const response = await client.pushModelCatalogProjection(payload);
    const body = response && response.ok ? response.data : null;
    if (!body || String(body.revision || '') !== revision) return null;
    if (Array.isArray(body.routable_model_ids)) {
      routableModelIds = new Set(body.routable_model_ids.map((id) => String(id || '')).filter(Boolean));
      const ownerByID = new Map(
        (Array.isArray(body.models) ? body.models : [])
          .filter((item) => item && item.id)
          .map((item) => [String(item.id), String(item.owned_by || '')])
      );
      routableModelOwners = new Map(
        [...routableModelIds].map((id) => [id, ownerByID.get(id) || ''])
      );
    }
    pushedModelCatalogRevision = revision;
    lastModelCatalogPush = {
      generation: Number(body.generation) || 0,
      revision,
      accepted: Number(body.accepted_count) || 0,
      routable: Array.isArray(body.routable_model_ids) ? body.routable_model_ids.length : 0
    };
    return body;
  }

  const buildAccountSync = deps.createGoAccountSync || createGoAccountSync;
  const buildManagementClient = deps.createGoManagementClient || createGoManagementClient;
  // 延迟 require 避免 host ↔ model-alias-store 的加载环；测试可注入替身。
  const loadAliases = typeof deps.loadAliases === 'function'
    ? deps.loadAliases
    : (fsImpl, aiHomeDir) => require('./model-alias-store').loadAliases(fsImpl, aiHomeDir);  const accountSync = settings.enabled && settings.accountSync && deps.aiHomeDir
    ? buildAccountSync({
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      getClient: managementClient,
      runtimeStates: deps.runtimeStates || null,
      // 探针结果由 Node 执行后推给 Go；未注入时同步只跳过这一步。
      probeState: deps.getLastUsageProbeState,
      // 用量增量导入：Node 承接的请求只有 Node 看得见（钉选自定义上游的流量不经过
      // Go）。host 在这里还没构造完，用闭包延迟取值，避免把管理客户端再建一份。
      goHost: { importUsageEvents: (events) => host.importUsageEvents(events) },
      log,
      intervalMs: deps.accountSyncIntervalMs
    })
    : null;

  // 首轮对账失败后，账号同步仍按周期重试：之后任一轮成功就放行，
  // 而不是让 Go 一直不接流量，直到下次重启。
  function accountsReady() {
    if (!accountsSynced && accountSync) {
      const last = accountSync.status();
      if (last && !last.failed && !last.skipped) accountsSynced = true;
    }
    return accountsSynced;
  }

  // 转发目标只在 Go 进程在服务、且账号成功同步过后可用；否则 Go 的 aih.db 可能还是空的。
  function getTarget() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint || !accountsReady()) return null;
    const endpoint = new URL(status.endpoint);
    return { host: endpoint.hostname, port: Number(endpoint.port), clientKey };
  }

  // G5：已划给 Go 的路由回落到 Node 时按原因计数，随 /readyz 暴露。
  const nodeFallbacks = createNodeFallbackCounters();

  const buildForwarder = deps.createGoCoreGatewayForwarder || createGoCoreGatewayForwarder;
  const forwarder = buildForwarder({
    http: deps.http,
    net: deps.net,
    routeTable: compileRouteTable(manifest),
    entryIds: ownership.entryIds,
    requiredClientKey: deps.requiredClientKey,
    writeJson: deps.writeJson,
    deferToNode: deps.deferToNode,
    mapPinnedAccountRef: (nodeRef) => goAccountRefFor(nodeRef),
    needsRequestModel: deps.needsRequestModel,
    maxRequestBodyBytes: deps.maxRequestBodyBytes,
    // 插件代次未确认时转发器会放弃转发；这是「Go 还没确认这一代」而非「Go 不支持」。
    pluginForwarding: (input) => {
      const plugin = typeof deps.pluginForwarding === 'function' ? deps.pluginForwarding(input) : null;
      if (plugin && plugin.defer) nodeFallbacks.record('plugin_generation_unconfirmed');
      return plugin;
    },
    recoverClaudeAuth: deps.recoverClaudeAuth,
    onServed: typeof deps.onServed === 'function'
      ? (input) => deps.onServed({ ...input, accountRef: nodeAccountRefFor(input.servedAccountRef) })
      : null,
    // 字段路径见 go-core.log 的 "decode rejected"；这里只记交还次数与请求 id。
    onDecodeFallback: ({ entryId, requestId, pluginCapability }) => {
      // 入口没有该能力的中间件（例如 native Responses 快路径不执行 gateway.attempt）：
      // 交还 Node 执行同一代插件，不是解码失败。
      if (pluginCapability) {
        nodeFallbacks.record('plugin_capability_handback');
        log.log(`\x1b[90m[aih:go-core]\x1b[0m plugin ${pluginCapability} needs Node, served by Node: route=${entryId} request=${requestId || '-'}`);
        return;
      }
      nodeFallbacks.record('decode_rejected');
      log.log(`\x1b[90m[aih:go-core]\x1b[0m decode rejected by Go, served by Node: route=${entryId} request=${requestId || '-'}`);
    },
    // 连接根本没建立：Go 一个字节都没收到，缓冲体原样交还 Node。
    onUnavailableFallback: ({ entryId, requestId, code }) => {
      nodeFallbacks.record('go_unavailable');
      log.log(`\x1b[90m[aih:go-core]\x1b[0m Go unreachable, served by Node: route=${entryId} code=${code || '-'} request=${requestId || '-'}`);
    },
    getTarget
  });

  function reportConfiguration() {
    for (const error of ownership.errors) {
      log.error(`\x1b[31m[aih:go-core]\x1b[0m canary route config rejected: ${error}`);
    }
    if (ownership.entryIds.size > 0 && !settings.enabled) {
      log.log('\x1b[90m[aih:go-core]\x1b[0m Go Core is disabled; assigned routes are served by Node');
    }
    if (ownership.entryIds.size > 0) {
      log.log(`\x1b[90m[aih:go-core]\x1b[0m Go-owned routes: ${[...ownership.entryIds].sort().join(', ')}`);
    }
    // 规则承接是静默失效风险最高的开关：打印出来，避免「以为 Go 在执行、其实全在 Node」。
    const ruleProviders = Array.isArray(settings.upstreamErrorRuleProviders)
      ? settings.upstreamErrorRuleProviders
      : [];
    log.log(
      ruleProviders.length > 0
        ? `\x1b[90m[aih:go-core]\x1b[0m upstream error rules: Go executes for ${ruleProviders.join(', ')}`
        : '\x1b[90m[aih:go-core]\x1b[0m upstream error rules: disabled (Node executes every account rule)'
    );
  }

  // Go 每次（重新）就绪后都要做的事：把 Node 的账号推进去、恢复可路由模型集合。
  // 崩溃重启后 Go 错过了停机期间的凭据更新，所以重启也必须重新对账，不只首启。
  async function runPostStart() {
    // Go 进程内存是新的：重启后必须重新推送别名表并重新确认接受集合，
    // 否则「上次推送内容未变化」会让 Go 在重启后一直缺少别名。
    pushedAliasRevision = '';
    acceptedAliasIds = new Set();
    // 规则投影同样活在 Go 进程内存里：重启后接受集合必须重新握手，
    // 否则会把「重启后规则全丢的 Go」当成已承接规则继续转发。
    pushedRuleRevision = '';
    acceptedErrorRuleRefs = new Set();
    pushedModelCatalogRevision = '';
    if (accountSync) {
      const first = await accountSync.reconcile();
      accountsSynced = Boolean(first && !first.failed && !first.skipped);
      const syncErrors = first.errors || [];
      log.log(`\x1b[90m[aih:go-core]\x1b[0m account sync: pushed=${first.pushed || 0} pulled=${first.pulled || 0} adopted=${first.adopted || 0} errors=${syncErrors.length}${summarizeSyncErrors(syncErrors)}`);
      accountSync.start();
    }
    await refreshRoutableModels();
    if (typeof deps.currentModelCatalogProjection === 'function') {
      const projection = deps.currentModelCatalogProjection();
      if (projection) await pushModelCatalogProjection(projection);
    }
    await pushModelAliases();
    await pushUpstreamErrorRules();
    if (!modelRefreshTimer) {
      modelRefreshTimer = setInterval(() => {
        refreshRoutableModels();
        // 别名表由 WebUI 维护，改动不会触发其它通知；随目录刷新一起对齐。
        pushModelAliases().catch(() => {});
        // 账号规则由账号/分组编辑维护，同样随刷新对齐（内容未变时不会重复 PUT）。
        pushUpstreamErrorRules().catch(() => {});
      }, modelRefreshIntervalMs);
      if (typeof modelRefreshTimer.unref === 'function') modelRefreshTimer.unref();
    }
  }

  function handleRestarted(status) {
    log.log(`\x1b[90m[aih:go-core]\x1b[0m Go Core restarted at ${status.endpoint} (pid=${status.pid}, restarts=${status.restarts})`);
    runPostStart().catch((error) => {
      log.error(`\x1b[31m[aih:go-core]\x1b[0m post-restart sync failed: ${error && (error.code || error.message)}`);
    });
  }

  async function start() {
    reportConfiguration();
    if (!settings.enabled) return supervisor.status();
    try {
      const status = await supervisor.start();
      log.log(`\x1b[90m[aih:go-core]\x1b[0m Go Core ready at ${status.endpoint} (pid=${status.pid})`);
      await runPostStart();
      return status;
    } catch (error) {
      // Go 启动失败不拖垮 Node 宿主：监督器会按退避继续重试，期间已划给 Go 的路由交还 Node。
      log.error(`\x1b[31m[aih:go-core]\x1b[0m Go Core start failed: ${error.code || error.message}; retrying with backoff`);
      return supervisor.status();
    }
  }

  async function stop() {
    if (modelRefreshTimer) clearInterval(modelRefreshTimer);
    modelRefreshTimer = null;
    if (accountSync) await accountSync.stop();
    return supervisor.stop();
  }

  // Go 自身的 /readyz（有无可用账号）只在按需查询时读取，避免 Node /readyz 之外的常驻轮询。
  async function probeGoReadyz() {
    const status = supervisor.status();
    if (status.state !== 'ready' || !status.endpoint) return { ready: false, error: 'go_core_not_serving' };
    const fetchImpl = deps.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(deps.readyzTimeoutMs) || 1500);
    try {
      const response = await fetchImpl(`${status.endpoint}/readyz`, { signal: controller.signal });
      const body = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
      return { ready: Boolean(response.ok && body && body.ready === true), error: response.ok ? '' : `http_${response.status}` };
    } catch (error) {
      return { ready: false, error: error && error.name === 'AbortError' ? 'go_core_readyz_timeout' : 'go_core_readyz_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Node /readyz 汇合的 Go 视图：进程、首轮同步、Go /readyz.ready、已划转路由。
   * 启用 Go 且有划转路由时核对转发和 Go 就绪；显式关闭时使用完整 Node 实现。
   */
  async function readiness() {
    const status = supervisor.status();
    const routes = [...ownership.entryIds].sort();
    const base = {
      enabled: settings.enabled,
      state: status.state,
      pid: status.pid,
      error: status.error,
      restarts: status.restarts || 0,
      restart_pending: Boolean(status.restartPending),
      accounts_synced: accountsReady(),
      routes,
      config_errors: ownership.errors,
      // 别名投影握手：Node 推送后 Go 是否已把新别名编译进路由目录。
      model_aliases: lastAliasPush,
      // 规则投影握手：Go 已承接哪些账号的自定义错误规则（未承接的账号继续交还 Node）。
      upstream_error_rules: lastRulesPush,
      // 公共目录投影握手：展示全局目录不等于 Go 承接这些模型的推理。
      model_catalog: lastModelCatalogPush,
      // G5：Node 承接已划转路由的次数（按原因）。Node 下线门槛看这个，不看路由表。
      node_fallbacks: nodeFallbacks.snapshot()
    };
    if (!settings.enabled) {
      // Disabled Go leaves all requests on the complete Node implementation.
      // Manifest ownership alone does not make an intentionally disabled sidecar
      // a readiness dependency; tryHandleHttp/Upgrade already defer to Node.
      return { ...base, go_ready: false, forwarding: false, ready: ownership.errors.length === 0 };
    }
    const probe = await probeGoReadyz();
    const forwarding = getTarget() !== null;
    return {
      ...base,
      go_ready: probe.ready,
      go_readyz_error: probe.error,
      forwarding,
      ready: ownership.errors.length === 0 && (routes.length === 0 || (forwarding && probe.ready))
    };
  }

  const host = {
    start,
    stop,
    readiness,
    // 转发目标是否可用（Go 在服务且首轮同步完成）。
    isForwardingAvailable: () => getTarget() !== null,
    // 宿主（server.js 的 deferToNode）在自己的判定点上登记交还原因，统一进 /readyz。
    recordNodeFallback: (reason) => nodeFallbacks.record(reason),
    routableModelIds: () => routableModelIds,
    // Go 已确认接受的别名 id：命中的别名请求可以交给 Go，其余继续保守交还 Node。
    acceptedAliasIds: () => acceptedAliasIds,
    // 主动把当前别名表推给 Go（启动与定时刷新都会调用；也可由宿主在别名变更后触发）。
    pushModelAliases,
    // Go 已确认承接规则的账号引用（Go 侧引用）；未确认的账号继续保守交还 Node。
    acceptedUpstreamErrorRuleRefs: () => acceptedErrorRuleRefs,
    // 主动把当前账号规则投影推给 Go（启动与定时刷新都会调用）。
    pushUpstreamErrorRules,
    pushModelCatalogProjection,
    modelCatalogStatus: () => lastModelCatalogPush,
    // Node shadow clients can compare Go's authoritative management projections
    // without changing the production owner of /v0/management/*.
    getManagementStatus: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.getManagementStatus();
      return response && response.ok ? response.data : null;
    },
    getManagementMetrics: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.getManagementMetrics();
      return response && response.ok ? response.data : null;
    },
    // 只读插件清单：控制面事实来自 Node 的 app-state.db，运行态来自 Go 已确认的投影。
    // 返回管理客户端的原始结构（{ ok, status, data, errorCode }），错误语义由插件路由映射成 503。
    getPluginInventory: async () => {
      const client = managementClient();
      if (!client || typeof client.getPluginInventory !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getPluginInventory();
    },
    // WebUI 终端的管理调用：open/attach/input/resize/close/clipboard/probe 都是
    // 普通 JSON 请求，Node 只做状态与响应体透传。
    terminalRequest: async ({ method = 'POST', path, body } = {}) => {
      const client = managementClient();
      if (!client || typeof client.send !== 'function') {
        return { ok: false, status: 0, data: null, body: null, errorCode: 'go_core_unavailable' };
      }
      if (typeof path !== 'string' || !path.startsWith('/v1/management/webui/terminal/')) {
        // 固定前缀：这里不是通用转发器，调用方不能借它打任意管理端点。
        return { ok: false, status: 0, data: null, body: null, errorCode: 'terminal_path_invalid' };
      }
      return client.send({ method, path, body });
    },
    // 终端 mux SSE：返回 fetch 的流式 Response，由 Node 终端路由逐块转发给浏览器。
    // 只允许终端前缀，避免把管理客户端的密钥变成任意 URL 的代理。
    openTerminalStream: async ({ path, query } = {}) => {
      const status = supervisor.status();
      if (status.state !== 'ready' || !status.endpoint) return null;
      if (typeof path !== 'string' || !path.startsWith('/v1/management/webui/terminal/')) return null;
      const suffix = query ? `?${query}` : '';
      const fetchImpl = deps.fetchImpl || fetch;
      return fetchImpl(`${status.endpoint}${path}${suffix}`, {
        headers: {
          authorization: `Bearer ${managementKey}`,
          accept: 'text/event-stream'
        }
      });
    },
    // 插件发布者信任根：写入口已收敛到 Go，Node 只转发 WebUI 请求。
    // 返回管理客户端的原始结构；status 0 表示 transport 失败，由插件路由映射成 503。
    getPluginTrustedKeys: async () => {
      const client = managementClient();
      if (!client || typeof client.getPluginTrustedKeys !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getPluginTrustedKeys();
    },
    addPluginTrustedKey: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.addPluginTrustedKey !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.addPluginTrustedKey(payload);
    },
    removePluginTrustedKey: async (keyId) => {
      const client = managementClient();
      if (!client || typeof client.removePluginTrustedKey !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.removePluginTrustedKey(keyId);
    },
    // 插件安装/卸载：制品生命周期已收敛到 Go。启用/停用/doctor 仍在 Node。
    // 返回管理客户端的原始结构（{ ok, status, body, errorCode }），错误语义由插件路由透传。
    installPlugin: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.installPlugin !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.installPlugin(payload);
    },
    uninstallPlugin: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.uninstallPlugin !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.uninstallPlugin(payload);
    },
    // enable/disable 的状态 CAS：Go 是唯一写者，Node 只提交候选并读取 revision。
    getSlashCommands: async (provider) => {
      const client = managementClient();
      if (!client || typeof client.getSlashCommands !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getSlashCommands(provider);
    },
    getSessionMessages: async (provider, sessionId, queryString) => {
      const client = managementClient();
      if (!client || typeof client.getSessionMessages !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getSessionMessages(provider, sessionId, queryString);
    },
    getSessionEvents: async (provider, sessionId, queryString) => {
      const client = managementClient();
      if (!client || typeof client.getSessionEvents !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getSessionEvents(provider, sessionId, queryString);
    },
    getGitDiff: async (projectPath, filePath, staged) => {
      const client = managementClient();
      if (!client || typeof client.getGitDiff !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getGitDiff(projectPath, filePath, staged);
    },
    getGitSummary: async (projectPath) => {
      const client = managementClient();
      if (!client || typeof client.getGitSummary !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getGitSummary(projectPath);
    },
    getSessionPreviews: async (sessions) => {
      const client = managementClient();
      if (!client || typeof client.getSessionPreviews !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getSessionPreviews(sessions);
    },
    getToolkitEnvironments: async () => {
      const client = managementClient();
      if (!client || typeof client.getToolkitEnvironments !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getToolkitEnvironments();
    },
    getProjects: async () => {
      const client = managementClient();
      if (!client || typeof client.getProjects !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getProjects();
    },
    getProjectSessions: async (projectPath) => {
      const client = managementClient();
      if (!client || typeof client.getProjectSessions !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getProjectSessions(projectPath);
    },
    // 项目级 SSE：Go 用文件事件 + Provider hook 状态驱动，Node 不轮询项目列表。
    // 返回 fetch 的流式 Response body，由路由逐块转发给浏览器。
    watchProjects: async () => {
      const client = managementClient();
      if (!client || typeof client.watchProjects !== 'function') {
        return { ok: false, status: 0, body: null, errorCode: 'go_core_unavailable', abort: () => {} };
      }
      return client.watchProjects();
    },
    // 强制刷新并广播快照：形状与 Node 本地实现一致（202 + broadcasted）。
    requestProjectsSnapshot: async () => {
      const client = managementClient();
      if (!client || typeof client.requestProjectsSnapshot !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.requestProjectsSnapshot();
    },
    getSshReverseTunnels: async () => {
      const client = managementClient();
      if (!client || typeof client.getSshReverseTunnels !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getSshReverseTunnels();
    },
    reconcileSshReverseTunnels: async () => {
      const client = managementClient();
      if (!client || typeof client.reconcileSshReverseTunnels !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.reconcileSshReverseTunnels();
    },
    watchSshReverseTunnels: async () => {
      const client = managementClient();
      if (!client || typeof client.watchSshReverseTunnels !== 'function') {
        return { ok: false, status: 0, body: null, errorCode: 'go_core_unavailable', abort: () => {} };
      }
      return client.watchSshReverseTunnels();
    },
    // SSH 远端目录浏览：Go 进程内 SSH；Node 只回传结果。
    browseSshHost: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.browseSshHost !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.browseSshHost(payload);
    },
    commitPluginState: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.commitPluginState !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.commitPluginState(payload);
    },
    // 插件实例启停：入口与状态机都归 Go；Node 只转发 WebUI/CLI 请求。
    enablePlugin: async (instanceId, payload) => {
      const client = managementClient();
      if (!client || typeof client.enablePlugin !== 'function') {
        return { ok: false, status: 0, data: null, body: null, errorCode: 'go_core_unavailable' };
      }
      return client.enablePlugin(instanceId, payload);
    },
    disablePlugin: async (instanceId, payload) => {
      const client = managementClient();
      if (!client || typeof client.disablePlugin !== 'function') {
        return { ok: false, status: 0, data: null, body: null, errorCode: 'go_core_unavailable' };
      }
      return client.disablePlugin(instanceId, payload);
    },
    // 应用启动权限设置读模型：GET 固定读 Go，Node 不再自己组装设置与权限目录。
    // 返回管理客户端的原始结构，错误语义由工具设置路由映射成 503/400。
    getToolAppSettings: async (appId) => {
      const client = managementClient();
      if (!client || typeof client.getToolAppSettings !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.getToolAppSettings(appId);
    },
    // 账号级规则全量读取：导入脚本的对拍来源，也供管理面排查「哪些账号带配置」。
    listAccountUpstreamErrorRules: async () => {
      const client = managementClient();
      if (!client || typeof client.listAccountUpstreamErrorRules !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      return client.listAccountUpstreamErrorRules();
    },
    goAccountRefFor,
    // 别名写入口（切片 C 用）：Node 侧只做契约映射，写事实落在 Go。
    //
    // 现在默认不启用——Node 仍是别名 owner，这些方法供翻转后使用；
    // 保留在门面里是为了让「能力边界」与真实可用操作一致。
    createModelAlias: async (record) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({ method: 'POST', path: '/v1/management/webui/model-aliases', body: record });
    },
    updateModelAlias: async (id, patch) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'PUT',
        path: '/v1/management/webui/model-aliases/' + encodeURIComponent(String(id || '')),
        body: patch
      });
    },
    deleteModelAlias: async (id) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'DELETE',
        path: '/v1/management/webui/model-aliases/' + encodeURIComponent(String(id || ''))
      });
    },
    setModelAliasEnabled: async (id, enabled) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'POST',
        path: '/v1/management/webui/model-aliases/' + encodeURIComponent(String(id || '')) + '/enabled',
        body: { enabled: enabled === true }
      });
    },
    replaceModelAliases: async (replaceIds, records) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'POST',
        path: '/v1/management/webui/model-aliases/replace',
        body: { replaceIds: Array.isArray(replaceIds) ? replaceIds : [], records: Array.isArray(records) ? records : [] }
      });
    },
    // 探针结果上报：Node 执行探针，Go 只落库并在账号视图里回读。
    pushAccountProbe: async (goRef, state) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const ref = String(goRef || '').trim();
      if (!ref) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'PATCH',
        path: '/v1/management/accounts/' + encodeURIComponent(ref) + '/probe',
        body: {
          status: String((state && state.status) || ''),
          error: String((state && state.error) || ''),
          checked_at_ms: Number((state && state.checkedAtMs) || 0)
        }
      });
    },
    // 账号视图影子读取：核对 Node 账号页投影与 Go 侧账号事实是否一致。
    listManagementAccounts: async (query = {}) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const params = new URLSearchParams();
      if (query.limit) params.set('limit', String(query.limit));
      if (query.afterRef) params.set('after_ref', String(query.afterRef));
      const search = params.toString();
      return client.send({
        method: 'GET',
        path: '/v1/management/accounts' + (search ? '?' + search : '')
      });
    },
    // 账号页读模型（Go 承接）：行形状就是 WebUI 契约，账号列表以它为准。
    // Node 只补自己独有的运行态富化字段，不再自己决定「有哪些账号」。
    listWebUiAccounts: async () => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({ method: 'GET', path: '/v1/management/webui/accounts' });
    },
    // 用量时间桶（图表）：按账号过滤，粒度由调用方给 day/week。
    getUsageBuckets: async (nodeRef, query = {}) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const params = new URLSearchParams();
      if (query.fromISO) params.set('from', String(query.fromISO));
      if (query.toISO) params.set('to', String(query.toISO));
      if (query.granularity) params.set('granularity', String(query.granularity));
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (goRef) params.set('account_ref', goRef);
      return client.send({ method: 'GET', path: '/v1/management/usage/buckets?' + params.toString() });
    },
    // 账号 token 用量（Go 的 usage_ledger 口径）：day/week/month/total + 分模型明细。
    //
    // 返回 client.send 的原始结果（{ ok, status, data, errorCode }），不在这里做形状适配：
    // 账号行装配（要平铺、要成本）与对拍脚本（要原始 from_ms/cost_known）对同一份数据
    // 的用法不同，适配属于调用方；宿主只负责「翻译 ref + 带上时区偏移 + 发请求」。
    getAccountTokenUsage: async (nodeRef, options = {}) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      const params = new URLSearchParams();
      // 必须显式下发：Go 不传偏移时按 UTC 切日/周/月，与账号行（Node 本地日历）对不上，
      // 对拍会得到「每天差几个小时」的假差异。缺省由 resolveTokenUsageTZOffset 补本地值。
      params.set('tz_offset_minutes', String(resolveTokenUsageTZOffset(options && options.tzOffsetMinutes)));
      return client.send({
        method: 'GET',
        path: '/v1/management/accounts/' + encodeURIComponent(goRef) + '/token-usage?' + params.toString()
      });
    },
    // 别名自动选号池的只读设置：Go 直接读 app-state.db 的 app_kv。
    getAccountAliasPool: async (provider, nodeRef) => {
      const client = managementClient();
      if (!client || typeof client.getAccountAliasPool !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getAccountAliasPool(provider, nodeRef);
    },
    // 写入别名池参与开关：Go 是 app_kv 的写者，Node 只做运行池重载。
    setAccountAliasPool: async (provider, nodeRef, participates) => {
      const client = managementClient();
      if (!client || typeof client.setAccountAliasPool !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setAccountAliasPool(provider, nodeRef, participates);
    },
    // 账号三段刷新（异步作业）：对外仍是 Node 的 202 + job + SSE，执行归 Go 的作业表。
    // 这里只发请求并原样返回管理客户端结果（{ ok, status, data, errorCode }）；
    // 「Go 不可用时回退本地实现」的判定属于调用方（见 webui-account-refresh）。
    refreshAccountWebUI: async (provider, accountRef) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(accountRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, data: null, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'POST',
        path: '/v1/management/webui/accounts/' + encodeURIComponent(String(provider || '').trim().toLowerCase())
          + '/' + encodeURIComponent(goRef) + '/refresh'
      });
    },
    // 只刷新额度：同一套作业语义，Go 侧 job.scope=usage（不带 branches 明细）。
    refreshAccountUsageWebUI: async (provider, accountRef) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(accountRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, data: null, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'POST',
        path: '/v1/management/webui/accounts/' + encodeURIComponent(String(provider || '').trim().toLowerCase())
          + '/' + encodeURIComponent(goRef) + '/refresh-usage'
      });
    },
    // 作业快照查询：POST 拿到 queued/running 后由 Node 轮询到终态。
    getRefreshJob: async (jobId) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      const id = String(jobId || '').trim();
      if (!id) return { ok: false, status: 0, data: null, errorCode: 'refresh_job_id_missing' };
      return client.send({
        method: 'GET',
        path: '/v1/management/webui/accounts/refresh-jobs/' + encodeURIComponent(id)
      });
    },
    // 宿主机入口可用性探测：Go 做 PATH / 安装落点 / .app bundle 实测，
    // Node 只在其上补静态能力声明与运行中实例（见 webui-account-routes 的 app-entries）。
    getAppEntries: async (refresh) => {
      const client = managementClient();
      if (!client || typeof client.getAppEntries !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getAppEntries(refresh === true);
    },
    // 认证来源链：Go 是形状与判定（installable / alreadyImported / 排序分组）的唯一装配方；
    // Node 路由只做形状校验与插件来源兜底，不再自己算一遍。
    getProviderAuthSources: async (provider) => {
      const client = managementClient();
      if (!client || typeof client.getProviderAuthSources !== 'function') {
        return { ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' };
      }
      const normalized = String(provider || '').trim().toLowerCase();
      if (!normalized) {
        return { ok: false, status: 0, data: null, errorCode: 'provider_missing' };
      }
      return client.getProviderAuthSources(normalized);
    },
    // 会话框大段粘贴阈值：Go 直接读 app-state.db 的 config:server。
    getChatPasteSettings: async () => {
      const client = managementClient();
      if (!client || typeof client.getChatPasteSettings !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getChatPasteSettings();
    },
    // 写入大段粘贴阈值：Go 在立即事务里只合并 largePasteChars。
    updateChatPasteSettings: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.updateChatPasteSettings !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.updateChatPasteSettings(payload);
    },
    // provider CLI 升级账本：Go 读 run/provider-cli-upgrade.json 并投影。
    getProviderCliUpgrade: async () => {
      const client = managementClient();
      if (!client || typeof client.getProviderCliUpgrade !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getProviderCliUpgrade();
    },
    // 控制面 profiles：Go 读写 app-state.db 的 control-plane:profiles。
    getControlPlaneProfiles: async () => {
      const client = managementClient();
      if (!client || typeof client.getControlPlaneProfiles !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getControlPlaneProfiles();
    },
    saveControlPlaneProfile: async (payload) => {
      const client = managementClient();
      if (!client || typeof client.saveControlPlaneProfile !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.saveControlPlaneProfile(payload);
    },
    setActiveControlPlaneProfile: async (profileId) => {
      const client = managementClient();
      if (!client || typeof client.setActiveControlPlaneProfile !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setActiveControlPlaneProfile(profileId);
    },
    removeControlPlaneProfile: async (profileId) => {
      const client = managementClient();
      if (!client || typeof client.removeControlPlaneProfile !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.removeControlPlaneProfile(profileId);
    },
    getControlPlaneEndpoints: async (params) => {
      const client = managementClient();
      if (!client || typeof client.getControlPlaneEndpoints !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getControlPlaneEndpoints(params);
    },
    // 全局用量配置：Go 直接读写 app-state.db 的 config:usage。
    getUsageConfig: async () => {
      const client = managementClient();
      if (!client || typeof client.getUsageConfig !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getUsageConfig();
    },
    setUsageConfig: async (config) => {
      const client = managementClient();
      if (!client || typeof client.setUsageConfig !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setUsageConfig(config);
    },
    // SSH 连接列表：Go 直接读 app-state.db 的 ssh_connections 并脱敏。
    getSshConnections: async () => {
      const client = managementClient();
      if (!client || typeof client.getSshConnections !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getSshConnections();
    },
    // SSH 工作区列表：Go 直接读 ssh_workspaces 并补远端影子目录。
    getSshWorkspaces: async () => {
      const client = managementClient();
      if (!client || typeof client.getSshWorkspaces !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getSshWorkspaces();
    },
    // SSH 工作区终端状态：Go 读工作区并探测自己的 tmux 会话。
    getSshWorkspaceSessions: async () => {
      const client = managementClient();
      if (!client || typeof client.getSshWorkspaceSessions !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getSshWorkspaceSessions();
    },
    // server 配置公开视图：Go 只读 config:server 并隐藏密钥。
    getServerConfig: async () => {
      const client = managementClient();
      if (!client || typeof client.getServerConfig !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getServerConfig();
    },
    // server 配置写入：Go 合并 patch 后整份写回 config:server。
    setServerConfig: async (patch) => {
      const client = managementClient();
      if (!client || typeof client.setServerConfig !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setServerConfig(patch);
    },
    // toolkit 执行目标：Go 只读 ssh_connections 并组装 local + ssh 目标。
    getToolkitTargets: async () => {
      const client = managementClient();
      if (!client || typeof client.getToolkitTargets !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getToolkitTargets();
    },
    // 账号配置文件查看：Go 读凭据记录与投影文件，默认脱敏。
    getAccountConfigFiles: async (provider, accountRef, mode) => {
      const client = managementClient();
      if (!client || typeof client.getAccountConfigFiles !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getAccountConfigFiles(provider, accountRef, mode);
    },
    // 账号 × 模型上下文窗口：Go 读覆盖 + 探测快照 + models.dev 目录。
    getAccountModelContext: async (provider, accountRef, models) => {
      const client = managementClient();
      if (!client || typeof client.getAccountModelContext !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getAccountModelContext(provider, accountRef, models);
    },
    // 单账号写入上下文窗口：Go 是覆盖表唯一写者。
    setAccountModelContext: async (provider, accountRef, payload) => {
      const client = managementClient();
      if (!client || typeof client.setAccountModelContext !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setAccountModelContext(provider, accountRef, payload);
    },
    // 批量写入同 provider 多个账号。
    setAccountModelContextBulk: async (provider, payload) => {
      const client = managementClient();
      if (!client || typeof client.setAccountModelContextBulk !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.setAccountModelContextBulk(provider, payload);
    },
    // DELETE 清空别名：与 POST tokens=null 同义。
    clearAccountModelContext: async (provider, accountRef, model) => {
      const client = managementClient();
      if (!client || typeof client.clearAccountModelContext !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.clearAccountModelContext(provider, accountRef, model);
    },
    // 窗口激活设置：Go 读写 app_kv 配置与账本，Node 只合并全局调度器状态。
    getWindowActivation: async (provider, accountRef) => {
      const client = managementClient();
      if (!client || typeof client.getWindowActivation !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getWindowActivation(provider, accountRef);
    },
    saveWindowActivationConfig: async (provider, accountRef, payload) => {
      const client = managementClient();
      if (!client || typeof client.saveWindowActivationConfig !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.saveWindowActivationConfig(provider, accountRef, payload);
    },
    // 账号额度重置历史：Go 直接读 app-state.db 的 account_quota_reset_events。
    // ref 不做 Go 翻译——写入方（Node 的额度检测器）用的就是 Node 账号引用。
    getAccountQuotaResetEvents: async (provider, nodeRef, query = {}) => {
      const client = managementClient();
      if (!client || typeof client.getAccountQuotaResetEvents !== 'function') {
        return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      }
      return client.getAccountQuotaResetEvents(provider, nodeRef, query);
    },
    // 额度统计（Go 侧实现）：窗口维度来自采样/事件，token 与成本来自账本。
    // Node 只在切流后调用；当前默认仍用本地实现（见 webui-account-quota-stats-routes）。
    getAccountQuotaStats: async (nodeRef, query = {}) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      const params = new URLSearchParams();
      if (query.windowMinutes) params.set('window', String(query.windowMinutes));
      if (query.rangeDays) params.set('range_days', String(query.rangeDays));
      if (query.scope) params.set('scope', String(query.scope));
      const search = params.toString();
      return client.send({
        method: 'GET',
        path: '/v1/management/accounts/' + encodeURIComponent(goRef) + '/quota-stats' + (search ? '?' + search : '')
      });
    },
    // 历史用量导入：Node 是 Go 管理客户端（与每次启动生成的密钥）的唯一持有者，
    // 所以导入脚本走 Node 中转，不直接打 Go 的 management 接口。
    importUsageEvents: async (events) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'POST',
        path: '/v1/management/usage/import',
        body: { events }
      });
    },
    // 上游错误映射组导入：Node 是 Go 管理客户端的唯一持有者（密钥不落盘），
    // scripts/import-upstream-mappings.js 必须经 /v0/webui/* 中转，不能直连 Go。
    // 返回 client.send 的原始结果（{ ok, status, data, errorCode }），形状适配在路由里做。
    createUpstreamMappingGroup: async (group) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'POST',
        path: '/v1/management/upstream-error-mapping-groups',
        body: group
      });
    },
    // 映射组只读影子：--verify 用它与 Node app-state 逐字段对拍。
    listUpstreamMappingGroups: async () => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({ method: 'GET', path: '/v1/management/upstream-error-mapping-groups' });
    },
    // 映射组 CRUD 的其余三条用例：WebUI 路由按「Go 优先、Node 降级」调用。
    // 与其它宿主方法一样返回 client.send 的原始结果，source/回落决策留在路由层。
    getUpstreamMappingGroup: async (id) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'GET',
        path: '/v1/management/upstream-error-mapping-groups/' + encodeURIComponent(String(id || ''))
      });
    },
    updateUpstreamMappingGroup: async (id, patch, version) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const body = { ...(patch && typeof patch === 'object' ? patch : {}) };
      // version 单独传参而不是塞进 patch：toggle 从 GET 拿到版本，DELETE 从查询串拿到，
      // 两条路径共用同一个 CAS 入口，调用方不必自己拼请求体。
      if (version != null) body.version = version;
      return client.send({
        method: 'PUT',
        path: '/v1/management/upstream-error-mapping-groups/' + encodeURIComponent(String(id || '')),
        body
      });
    },
    deleteUpstreamMappingGroup: async (id, version) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const params = new URLSearchParams();
      if (version != null) params.set('version', String(version));
      const search = params.toString();
      return client.send({
        method: 'DELETE',
        path: '/v1/management/upstream-error-mapping-groups/' + encodeURIComponent(String(id || ''))
          + (search ? '?' + search : '')
      });
    },
    // 单账号视图：watch 增量事件与单账号响应按需取 Go 事实（不缓存，避免启停回弹）。
    // 与 setAccountEnabled 一样先翻译 Node ref → Go ref（同步 rekey 后两侧不同）。
    getManagementAccount: async (nodeRef) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      return client.getAccount(goRef);
    },
    // 别名影子读取：Node 仍是 owner，这里只用于核对 Go 侧落库副本是否与之一致。
    listModelAliases: async () => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({ method: 'GET', path: '/v1/management/webui/model-aliases' });
    },
    // 账号凭据编辑的写入口已切到 Go：Node 只负责 UI 适配，轮换、身份校验和 CAS 都在 Go。
    isEnabled: () => settings.enabled === true,
    editStaticCredential: async (nodeRef, edit) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      // 静态 accountRef 已在 2026-11-04 与 Node 统一，直接用 Node ref 寻址；
      // 空密钥/未带地址的语义由 Go 用例解释（application/accounts.StaticCredentialEdit）。
      return client.send({
        method: 'PUT',
        path: `/v1/management/accounts/${encodeURIComponent(nodeRef)}/credential/edit`,
        body: edit
      });
    },
    // Provider 默认账号的持久事实由 Go 落库；Node 的 app_kv 与宿主配置是投影。
    setProviderDefault: async (provider, nodeRef) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.setProviderDefault(provider, managementGoRef(nodeRef, goAccountRefFor));
    },
    clearProviderDefault: async (provider) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.clearProviderDefault(provider);
    },
    // 用户启停的持久事实（accounts.enabled）由 Go 落库；Node 只投影状态。
    //
    // 必须先把 Node ref 翻译成 Go ref：同步 rekey 后两侧 ref 不同（cline 实测
    // Node acct_3e25… → Go acct_0176…），直接用 Node ref 会得到 account_not_found。
    setAccountEnabled: async (nodeRef, enabled) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'PATCH',
        path: `/v1/management/accounts/${encodeURIComponent(goRef)}`,
        body: { enabled: enabled === true }
      });
    },
    // 账号级路由排除：告诉 Go「这个账号不要进路由候选与模型目录」。
    //
    // 为什么需要这条用例而不是直接停用账号：自定义上游账号（自建反代 / 另一台 AIH 网关）
    // 的额度与失败语义只有 Node 懂，但账号本身在 Go 里仍要保留（凭据、探针、账号页都还
    // 读它）。排除是路由层的事实，与 enabled 是两件事——停用会改用户可见的启停状态。
    //
    // 与 setAccountEnabled 同理，必须先把 Node ref 翻译成 Go ref：同步 rekey 后两侧 ref
    // 不同，直接用 Node ref 会得到 account_not_found，排除静默失效、账号继续被 Go 选中。
    setAccountRouting: async (nodeRef, excluded, reason) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'PUT',
        path: `/v1/management/accounts/${encodeURIComponent(goRef)}/routing`,
        // 排除原因随请求下发：Go 侧诊断与账号页要能区分「为什么这个账号不在路由里」。
        body: { excluded: excluded === true, reason: String(reason || '').trim() }
      });
    },
    // 集合导入由 Go 落库；Node 只负责解析上传文件、任务外壳和读模型刷新。
    importAccounts: async (document) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      return client.send({
        method: 'POST',
        path: '/v1/management/account-imports/aih-accounts',
        body: document
      });
    },
    // 集合导出由 Go 生成；Node 只做传输（aih-accounts v1）。
    exportAccounts: async ({ providers = [], accountRefs = [] } = {}) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const params = new URLSearchParams();
      for (const provider of providers) {
        const value = String(provider || '').trim();
        if (value) params.append('provider', value);
      }
      for (const accountRef of accountRefs) {
        const value = String(accountRef || '').trim();
        if (value) params.append('account_ref', value);
      }
      const suffix = params.toString();
      const response = await client.send({
        method: 'GET',
        path: `/v1/management/accounts/export/aih-accounts${suffix ? `?${suffix}` : ''}`
      });
      return response && response.ok
        ? { ok: true, status: response.status, document: response.body }
        : { ok: false, status: response && response.status || 0, errorCode: response && response.errorCode || 'go_export_failed' };
    },
    // 账号删除的持久事实（行 + 墓碑）由 Go 落库；Node 随后只清理投影与运行时。
    deleteAccount: async (nodeRef) => {
      const client = managementClient();
      if (!client) return { ok: false, status: 0, errorCode: 'go_core_unavailable' };
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return { ok: false, status: 0, errorCode: 'go_account_ref_missing' };
      return client.send({
        method: 'DELETE',
        path: `/v1/management/accounts/${encodeURIComponent(goRef)}`
      });
    },
    // 把插件发布投影推给 Go 管理接口；Go 未就绪时返回 null（调用方视为未确认）。
    pushPluginProjection: async (payload) => {
      const client = managementClient();
      return client ? client.pushPluginProjection(payload) : null;
    },
    // 内部聊天轮次：Node 的 turn.submit 把本轮指令交给 Go，由 Go 完成账号征召、
    // 上游请求、改流与记账。返回 fetch 的 Response（SSE 由调用方消费）；
    // Go 未就绪时返回 null，调用方据此给出明确的 503 而不是假装成功。
    openWebUiChatTurn: async ({ sessionId, accountRef, body, signal } = {}) => {
      const status = supervisor.status();
      if (status.state !== 'ready' || !status.endpoint) return null;
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const fetchImpl = deps.fetchImpl || fetch;
      const pinned = String(accountRef || '').trim();
      return fetchImpl(
        `${status.endpoint}/v1/management/webui/chat/sessions/${encodeURIComponent(id)}/commands`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${managementKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(pinned ? { 'X-Account-Ref': pinned } : {})
          },
          body: JSON.stringify(body || {}),
          signal
        }
      );
    },
    // 批量读取账号模型关系（WebUI 模型目录读 Go 的入口）。
    //
    // 只做 GET：Go 是 account_models 的权威存储，Node 的探测结果经模型刷新写回 Go。
    // 返回 null 表示 Go 未就绪（调用方回落 Node 缓存，不能把「读不到」当成「没有模型」）。
    listAccountModels: async (path) => {
      const client = managementClient();
      if (!client) return null;
      // 只允许读这一条路径：调用方传 query 串进来，不接受任意 URL（避免把管理客户端
      // 变成通用转发器）。
      const target = typeof path === 'string' && path.startsWith('/v1/management/account-models')
        ? path
        : '/v1/management/account-models';
      return client.send({ method: 'GET', path: target });
    },
    // 全局模型目录刷新：Go 侧按账号扇出上游探测并落库。
    //
    // 返回管理客户端的原始结构（{ ok, status, data, errorCode }）；Go 未就绪时返回 null，
    // 调用方据此回落到 Node 自己的探测（旧行为），而不是把「没刷新」当成成功。
    refreshWebUiModelCatalog: async () => {
      const client = managementClient();
      if (!client) return null;
      return client.send({ method: 'POST', path: '/v1/management/webui/openai-models/refresh' });
    },
    // 账号模型目录刷新（POST /v1/management/accounts/{ref}/models/refresh）：
    // Go 用规范凭据重新探测并落库。Node 只做 Node ref → Go ref 翻译与传输；
    // Go 未就绪时返回 null，调用方据此退化为「标记缓存 stale」。
    refreshAccountModels: async (nodeRef) => {
      const client = managementClient();
      if (!client) return null;
      const goRef = managementGoRef(nodeRef, goAccountRefFor);
      if (!goRef) return null;
      return client.send({
        method: 'POST',
        path: '/v1/management/accounts/' + encodeURIComponent(goRef) + '/models/refresh'
      });
    },
    // OAuth Job 公开快照：Node 是登录执行者，Go 负责跨重启持久化。
    pushOAuthJob: async (record) => {
      const client = managementClient();
      return client ? client.putOAuthJob(record) : null;
    },
    listOAuthJobs: async (activeOnly) => {
      const client = managementClient();
      return client ? client.listOAuthJobs(activeOnly) : null;
    },
    getOAuthJob: async (jobId) => {
      const client = managementClient();
      return client ? client.getOAuthJob(jobId) : null;
    },
    // Go 承接的 OAuth 登录（zcode 固定 / codex 实验开关）：Begin / Callback / Cancel 都走管理 API。
    // 返回管理客户端的原始结构（{ ok, status, data, errorCode }），
    // 失败语义由 web-account-auth-go-jobs 映射成 job 失败原因；Go 未就绪时返回 null。
    startAccountAuthJob: async (payload) => {
      const client = managementClient();
      return client ? client.startAccountAuthJob(payload) : null;
    },
    completeAccountAuthJob: async (jobId, callback) => {
      const client = managementClient();
      return client ? client.completeAccountAuthJob(jobId, callback) : null;
    },
    cancelAccountAuthJob: async (jobId) => {
      const client = managementClient();
      return client ? client.cancelAccountAuthJob(jobId) : null;
    },
    nodeAccountRefFor,
    // Go 的引导密钥（内部发布回调用）；只给回环内部路由校验，不暴露给 WebUI。
    managementKey: () => managementKey,
    // 让 Node 在 OAuth 恢复成功后立即把新凭据推回 Go，不等待下一轮定时对账。
    reconcileAccounts: () => (accountSync ? accountSync.reconcile() : null),
    goRefsByNodeRef,
    // 读取 Go 的账号运行态快照；Go 未就绪或失败时返回 null。
    listAccountRuntime: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listAccountRuntime();
      return response && response.ok && Array.isArray(response.data) ? response.data : null;
    },
    // 上报账号级运行态文档；Go 未就绪时静默跳过（Node 本地状态仍是调度依据）。
    putRuntimeState: async (goRef, state, updatedAt) => {
      const client = managementClient();
      if (!client) return null;
      return client.putRuntimeState(goRef, state, updatedAt);
    },
    deleteRuntimeState: async (goRef, updatedAt) => {
      const client = managementClient();
      if (!client) return null;
      return client.deleteRuntimeState(goRef, updatedAt);
    },
    // 读取 Go 派生的账号运行态（status/until/reason）；Go 未就绪或失败时返回 null。
    listRuntimeStates: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listRuntimeStates();
      return response && response.ok && Array.isArray(response.data) ? response.data : null;
    },
    // 读取 Go 持久化的账号页展示状态；Go 未就绪或失败时返回 null。
    listAccountUIStates: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listUIStates();
      return response && response.ok && Array.isArray(response.data) ? response.data : null;
    },
    // 读取 Go 派生的账号级额度状态（含 codex Team/Free pending）；Go 未就绪或失败时返回 null。
    listAccountQuotaStates: async () => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listAccountQuotaStates();
      return response && response.ok && Array.isArray(response.data) ? response.data : null;
    },
    // 读取 Go 的 token 用量事件页 { boot_id, latest_seq, truncated, data }；Go 未就绪或失败时返回 null。
    listAccountUsageEvents: async (afterSeq) => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listAccountUsageEvents(afterSeq);
      const body = response && response.ok ? response.body : null;
      return body && typeof body === 'object' && Array.isArray(body.data) && body.boot_id ? body : null;
    },
    // 读取 Go 的账号结果时间桶；Go 未就绪时返回 null。
    listAccountOutcomes: async (granularity, fromMs) => {
      const client = managementClient();
      if (!client) return null;
      const response = await client.listAccountOutcomes(granularity, fromMs);
      return response && response.ok && Array.isArray(response.data) ? response.data : null;
    },
    routableModelOwner: (model) => (routableModelOwners ? routableModelOwners.get(model) || '' : ''),
    status: () => ({
      ...supervisor.status(),
      routes: [...ownership.entryIds].sort(),
      configErrors: ownership.errors,
      accountsSynced: accountsReady(),
      modelCatalog: lastModelCatalogPush,
      modelAliases: lastAliasPush,
      upstreamErrorRules: lastRulesPush,
      accountSync: accountSync ? accountSync.status() : null
    }),
    tryHandleHttp: forwarder.tryHandleHttp,
    tryHandleUpgrade: forwarder.tryHandleUpgrade
  };
  return host;
}

module.exports = {
  createGoCoreHost,
  resolveGoCoreSettings,
  __private: {
    managementGoRef,
    translateNodeRefToGo,
    translateGoRefToNode
  }
};
