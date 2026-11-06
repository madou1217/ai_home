'use strict';

// Node(app-state.db) <-> Go(aih.db) 账号双向同步（Mediator + 周期对账）。
//
// 两个进程各自持有账号库是部署边界；本模块让二者在运行期收敛为同一个账号世界：
//   1. Go -> Node 凭据回写：Go 在推理链路刷新了 OAuth token（refresh_token 会轮换），
//      只在 Go 的代际严格更新时经 CAS 写回 Node，避免 Node 再用已被消费的旧 refresh_token。
//   2. Node -> Go 推送：Node 是账号写入口（WebUI/CLI 登录、导入、删除），新增/变更的账号经
//      Go 管理 API 导入（Go 的路由索引因此即时可见，直接写 aih.db 则要重启才生效）。
//   3. 启停状态与 Provider 默认账号以 Node 为准同步到 Go。
//      账号级模型开关同步为 Go 人工模型策略（规划见 go-model-policy-sync）。
//   4. 删除：只删除本同步建立过映射、且 Node 源账号已消失的 Go 账号；从不删除 Go 独有账号。
//      映射改指新 Go 账号时，旧映射同样是本同步建立的，一并删除——否则下一轮收养会把它
//      当成 Go 独有账号写回 Node（编辑 URL 多出一个账号的来源）。
//   5. 收养：按 provider 的凭据策略把 Go 只读快照导入 Node（未声明的类型仅上报）。
//      同一把静态密钥已对应 Node 账号的 Go 记录不收养：它是旧 base_url 派生的过期投影，
//      不是另一个账号。
// 顺序即上面编号：先回写再推送，保证推送的永远不是过期凭据。

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const { readNodeAccounts } = require('../account/go-bridge/node-account-reader');
const { readGoAccounts } = require('../account/go-bridge/go-account-store-reader');
const { translateNodeAccount, STATIC_CREATE_PATH } = require('../account/go-bridge/go-import-translator');
const { adoptGoAccount } = require('../account/go-bridge/go-account-adoption');
const { materializeZcodeNativeAuth, preserveZcodeNativeEncoding } = require('../account/go-bridge/zcode-native-auth');
const { planModelPolicySync, policyKey } = require('../account/go-bridge/go-model-policy-sync');
const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');
const { readProviderBaseUrl } = require('../account/provider-credential-env');
const { buildUsageFacts } = require('../account/go-bridge/go-usage-facts');
const { compareAndSwapAccountNativeAuth } = require('./account-credential-store');
const { readJsonValue, readJsonValuesByPrefix, writeJsonValue } = require('./app-state-store');
const { MODEL_CATALOG_SETTINGS_DB_KEY, normalizeModelCatalogSettings } = require('./model-catalog-settings-store');

const SYNC_STATE_KEY = 'go-account-sync:state';
const DEFAULT_INTERVAL_MS = 15000;
const PERMANENT_IMPORT_ERROR = 'invalid_native_artifacts';
// 代际仲裁拒绝：Go 侧已持有同代或更新凭据（core/accounts.NewerThan），本次内容
// 「无法证明比当前凭据更新」。内容本身有效，但同一份内容再推多少次结论都不会变。
const SETTLED_IMPORT_ERROR = 'account_import_generation_unordered';
// Go 的静态账号身份 = 密钥 + base_url；编辑 URL 会派生出不同的 accountRef。已链接的
// 静态账号必须走原地轮换，不能重新创建。
const STATIC_AUTH_CLASSES = new Set(['api_key', 'auth_token']);
const USAGE_SNAPSHOT_PREFIX = 'account:usage:';
// Go 路由排除的原因名：Go 侧拿它做诊断与账号页展示，改名字要两边一起改。
const CUSTOM_UPSTREAM_ROUTING_REASON = 'custom_upstream';

function usageSnapshotCapturedAt(snapshot) {
  const value = Number(snapshot && snapshot.capturedAt);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isStaticPlan(plan) {
  return plan
    && plan.kind === 'import'
    && STATIC_AUTH_CLASSES.has(plan.authClass)
    && plan.request
    && plan.request.body
    && plan.request.body.auth;
}

function rotateStaticCredentialPlan(plan, goRef) {
  return {
    ...plan,
    request: {
      method: 'PUT',
      path: `${STATIC_CREATE_PATH}/${encodeURIComponent(goRef)}/credential`,
      body: { auth: plan.request.body.auth }
    }
  };
}

// Go 静态账号的密钥（api_key / auth_token）。非静态账号返回空串。
function goStaticSecret(account) {
  const credential = account && account.credential && typeof account.credential === 'object'
    ? account.credential
    : {};
  if (!account || !STATIC_AUTH_CLASSES.has(account.authKind)) return '';
  return account.authKind === 'auth_token'
    ? text(credential.auth_token)
    : text(credential.api_key);
}

function nodeStaticSecrets(record) {
  const env = record && record.env && typeof record.env === 'object' ? record.env : {};
  if (record.provider === 'codex') return [text(env.OPENAI_API_KEY)];
  if (record.provider === 'claude') return [text(env.ANTHROPIC_API_KEY), text(env.ANTHROPIC_AUTH_TOKEN)];
  return [];
}

// 同一把静态密钥已对应某个 Node 账号时，Go 里其它 ref 的同密钥记录只是旧 base_url
// 派生的投影，不是新账号。
function findNodeAccountWithStaticSecret(accounts, goAccount) {
  const secret = goStaticSecret(goAccount);
  if (!secret) return null;
  return accounts.find((record) => record.provider === goAccount.provider
    && nodeStaticSecrets(record).includes(secret)) || null;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// 推送指纹只覆盖账号内容：sub2api 文档的 exported_at 每轮都不同，不能让它触发重复推送。
function planFingerprint(plan) {
  const body = plan.request.body && typeof plan.request.body === 'object' ? { ...plan.request.body } : plan.request.body;
  if (body && typeof body === 'object') delete body.exported_at;
  return fingerprint({ path: plan.request.path, body });
}

function isoToMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// links: nodeRef -> {goRef, print}。一个 Go 账号可被多个 Node 账号映射（Node 视为不同、
// Go 规范化后同一身份）；Go 账号由同步「拥有」当且仅当至少有一条 link 指向它。
// modelPolicies: 本同步写入过的 Go 非 inherit 模型策略键，只有它们会被还原。
// rejectedImports: nodeRef -> {print, error[, goRef]}。终态拒绝只推送一次，不持久化凭据：
//   - invalid_native_artifacts：内容永远进不了 Go，等内容变化再试。
//   - account_import_generation_unordered：Go 已有同代或更新凭据，等凭据代际推进再试。
// goRef 只在拒绝时已知目标账号才记录：Go 账号被删后据此让缓存让路、重新导入，
// 否则缓存会把重建永久挡住。
// Go 原生凭据校验器的版本。放宽或修正 Go 的身份策略后递增：缓存里「内容永远进不了 Go」
// 的终态拒绝是针对旧校验器下的结论，升级后必须重新尝试一次，否则修好的账号永远被缓存挡住。
// v2（2026-10-31）：zcode access_token 数字 user_id、cline accountId=external_id、
// qoder opaque credentials、opencode Console metadata.accountID。
const NATIVE_VALIDATOR_VERSION = 2;

function emptyState() {
  return { links: {}, modelPolicies: [], rejectedImports: {}, uiStates: {}, runtimeStates: {} };
}

// Go 凭据比 Node 更新时返回写回后的 Node nativeAuth，否则返回 null。
function newerGoNativeAuth(record, goAccount) {
  const go = goAccount.credential || {};
  const native = record.nativeAuth || {};
  if (record.provider === 'codex' && native.auth && native.auth.tokens && go.access_token) {
    const goMs = Number(go.refreshed_at_ms) || 0;
    const nodeMs = isoToMs(native.auth.last_refresh);
    const tokens = native.auth.tokens;
    const differs = tokens.access_token !== go.access_token || tokens.refresh_token !== go.refresh_token || tokens.id_token !== go.id_token;
    if (!differs || goMs <= nodeMs) return null;
    return {
      ...native,
      auth: {
        ...native.auth,
        tokens: { ...tokens, access_token: go.access_token, refresh_token: go.refresh_token, id_token: go.id_token },
        last_refresh: new Date(goMs).toISOString()
      }
    };
  }
  if (record.provider === 'claude' && native.credentials && go.access_token && go.refresh_token) {
    const key = native.credentials.claudeAiOauth ? 'claudeAiOauth' : 'claude_ai_oauth';
    const oauth = native.credentials[key] || {};
    const nodeExpiresAt = Number(oauth.expiresAt || oauth.expires_at) || 0;
    const goExpiresAt = Number(go.expires_at_ms) || 0;
    const differs = (oauth.accessToken || oauth.access_token) !== go.access_token
      || (oauth.refreshToken || oauth.refresh_token) !== go.refresh_token;
    if (!differs || goExpiresAt <= nodeExpiresAt) return null;
    const next = { ...oauth, accessToken: go.access_token, refreshToken: go.refresh_token, expiresAt: goExpiresAt };
    if ('access_token' in oauth) next.access_token = go.access_token;
    if ('refresh_token' in oauth) next.refresh_token = go.refresh_token;
    if ('expires_at' in oauth) next.expires_at = goExpiresAt;
    return { ...native, credentials: { ...native.credentials, [key]: next } };
  }
  if (record.provider === 'agy' && native.oauthToken && native.oauthToken.token && go.access_token) {
    const token = native.oauthToken.token;
    const goMs = Number(go.refreshed_at_ms) || Number(go.expires_at_ms) || 0;
    const nodeMs = Number(token.refreshed_at_ms) || Number(token.expires_at_ms) || 0;
    const differs = token.access_token !== go.access_token || token.refresh_token !== go.refresh_token;
    if (!differs || goMs <= nodeMs) return null;
    return {
      ...native,
      oauthToken: {
        ...native.oauthToken,
        token: {
          ...token,
          access_token: go.access_token,
          refresh_token: go.refresh_token,
          expires_at_ms: Number(go.expires_at_ms) || token.expires_at_ms,
          refreshed_at_ms: Number(go.refreshed_at_ms) || token.refreshed_at_ms
        }
      }
    };
  }
  if (go.native_auth_json && typeof go.native_auth_json === 'object') {
    if (record.provider === 'zcode') {
      const current = materializeZcodeNativeAuth(native);
      const incoming = materializeZcodeNativeAuth(go.native_auth_json);
      if (!current || !incoming || isDeepStrictEqual(current, incoming)) return null;
      if (goAccount.credentialUpdatedAtMs <= record.nativeAuthUpdatedAt) return null;
      return preserveZcodeNativeEncoding(native, incoming);
    }
    if (fingerprint(go.native_auth_json) === fingerprint(native)) return null;
    if (goAccount.credentialUpdatedAtMs <= record.nativeAuthUpdatedAt) return null;
    return go.native_auth_json;
  }
  return null;
}

// 账号是否「自定义上游」（自建反代 / 另一台 AIH 网关）。
//
// 判定只调 official-upstream-endpoint 的唯一口径，这里只负责从同步记录里取出它需要的
// 三件事实：provider、是否 API 密钥模式（account_state.api_key_mode）、以及按 Provider
// 凭据合同读出的 base URL。**不要在同步层再写一套主机名/域名规则**——判定错一次的后果
// 是官方账号被排除出 Go 路由（流量全回 Node），或者自定义上游账号进了 Go 路由。
function isCustomUpstreamSyncAccount(record) {
  const provider = text(record && record.provider);
  if (!provider) return false;
  return isCustomUpstreamAccount({
    provider,
    apiKeyMode: Boolean(record.state && record.state.apiKeyMode),
    baseUrl: readProviderBaseUrl(provider, record.env)
  });
}

// 3b-2. 账号级路由排除：把 Node 判定为自定义上游的账号推给 Go。
//
// 为什么由 Node 推而不是 Go 自己判：账号库、凭据与「编辑配置」都归 Node，只有这一侧
// 同时看得到 provider、凭据形态和 base URL。Go 再写一份主机表就会和 Node 漂移。
//
// 为什么不是以前的「整池交还 Node」：只要池里有任意一个自定义上游账号，整条推理入口
// 就留在 Node，其余官方账号的流量也跟着回 Node，Go 的用量账本于是长期为空。账号级
// 排除把粒度收到账号：被排除的账号不进 Go 的路由候选与模型目录，其余账号照常交给 Go。
//
// 去重口径：签名 = 期望状态（`excluded:<reason>` / `included`）。值不变不重复 PUT；
// 推送失败不写签名，下一轮继续重试——否则一次网络抖动会让排除永久失效，被排除的账号
// 重新进 Go 路由，症状是「自定义上游的额度/失败语义偶尔被写成 Go 本地账号状态」。
//
// createdRefs：本轮刚在 Go 里新建的账号行。Go 的行是新建的，旧签名记录的是上一个行
// 的状态（删除后同密钥同 URL 重新导入会得到同一个 goRef），必须清掉重推。
async function pushAccountRoutingExclusions({
  client,
  primaryByGoRef,
  pushedSignatures,
  createdRefs,
  result
}) {
  if (!client || typeof client.send !== 'function' || !primaryByGoRef) return;
  if (pushedSignatures && createdRefs && createdRefs.size > 0) {
    for (const goRef of createdRefs) pushedSignatures.delete(goRef);
  }
  for (const [goRef, record] of primaryByGoRef) {
    const excluded = isCustomUpstreamSyncAccount(record);
    const reason = excluded ? CUSTOM_UPSTREAM_ROUTING_REASON : '';
    const signature = excluded ? `excluded:${reason}` : 'included';
    const previous = pushedSignatures.get(goRef);
    if (previous === signature) continue;
    // 「不排除」是 Go 的默认状态：从没被排除过的官方账号不必每轮发一次放行请求，
    // 否则每次启动都要为几十个账号各写一行。只有真的从排除翻回官方时才要清标记。
    if (!excluded && previous === undefined) continue;
    const response = await client.send({
      method: 'PUT',
      path: '/v1/management/accounts/' + encodeURIComponent(goRef) + '/routing',
      body: { excluded, reason }
    });
    if (response && response.ok) {
      pushedSignatures.set(goRef, signature);
      result.routingExclusionsPushed += 1;
      continue;
    }
    result.errors.push({
      account_ref: goRef,
      step: 'routing_exclusion',
      error: (response && response.errorCode) || 'unknown'
    });
  }
}

// pushAccountProbes 把「变化过的」探针结果推给 Go。
//
// 为什么独立成函数：这段逻辑只依赖 client / 主账号表 / 探针读取器 / 去重表，
// 抽出来就能直接单测，不必先造出完整的 Node/Go 账号库去跑整轮对账。
async function pushAccountProbes({
  client,
  primaryByGoRef,
  probeState,
  pushedSignatures,
  result
}) {
  if (!probeState || !client || typeof client.send !== 'function' || !primaryByGoRef) return;
  for (const [goRef, record] of primaryByGoRef) {
    let state = null;
    try {
      state = probeState(record.provider, record.accountRef);
    } catch (_error) {
      state = null;
    }
    if (!state) continue;
    const checkedAt = Number(state.checkedAt) || 0;
    const errorText = String(state.error || '');
    const signature = checkedAt + ':' + errorText;
    if (pushedSignatures.get(goRef) === signature) continue;
    const response = await client.send({
      method: 'PATCH',
      path: '/v1/management/accounts/' + encodeURIComponent(goRef) + '/probe',
      body: {
        status: errorText ? 'error' : 'ok',
        error: errorText,
        checked_at_ms: checkedAt
      }
    });
    if (response && response.ok) {
      pushedSignatures.set(goRef, signature);
      result.probePushed += 1;
      continue;
    }
    result.errors.push({
      account_ref: goRef,
      step: 'probe',
      error: (response && response.errorCode) || 'unknown'
    });
  }
}

function createGoAccountSync(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const aiHomeDir = deps.aiHomeDir;
  const getClient = typeof deps.getClient === 'function' ? deps.getClient : () => null;
  const log = deps.log || console;
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_INTERVAL_MS;
  const readNode = deps.readNodeAccounts || ((dir) => readNodeAccounts(dir, { fs }));
  const readGo = deps.readGoAccounts || ((dir) => readGoAccounts(dir, { fs }));
  const runtimeStates = deps.runtimeStates || null;
  // 探针结果来源：Node 执行探针，这里只负责把变化推给 Go。
  const probeState = typeof deps.probeState === 'function' ? deps.probeState : null;
  // goRef → 上次推送的签名。避免每轮对账都重复推同一份结果。
  const pushedProbeSignatures = new Map();
  // goRef → 上次推送的路由排除状态（excluded:reason / included）。
  const pushedRoutingSignatures = new Map();
  const readModelSettings = deps.readModelCatalogSettings
    || ((dir) => normalizeModelCatalogSettings(readJsonValue(fs, dir, MODEL_CATALOG_SETTINGS_DB_KEY)));
  let timer = null;
  let running = null;
  let lastResult = null;

  function loadState() {
    const stored = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY);
    if (!stored || typeof stored !== 'object' || !stored.links || typeof stored.links !== 'object') return emptyState();
    const modelPolicies = Array.isArray(stored.modelPolicies) ? stored.modelPolicies.map(String) : [];
    const rejectedImports = {};
    const validatorChanged = Number(stored.validatorVersion || 1) !== NATIVE_VALIDATOR_VERSION;
    for (const [nodeRef, rejection] of Object.entries(stored.rejectedImports || {})) {
      const terminal = rejection
        && (rejection.error === PERMANENT_IMPORT_ERROR || rejection.error === SETTLED_IMPORT_ERROR);
      if (!terminal || !/^[a-f0-9]{64}$/.test(rejection.print)) continue;
      // 校验器升级后，「凭据结构无效」的旧结论作废，重新推送一次。
      if (validatorChanged && rejection.error === PERMANENT_IMPORT_ERROR) continue;
      rejectedImports[nodeRef] = { print: rejection.print, error: rejection.error };
      if (rejection.goRef) rejectedImports[nodeRef].goRef = String(rejection.goRef);
    }
    const uiStates = stored.uiStates && typeof stored.uiStates === 'object' ? { ...stored.uiStates } : {};
    const runtimeStates = stored.runtimeStates && typeof stored.runtimeStates === 'object' ? { ...stored.runtimeStates } : {};
    return { links: { ...stored.links }, modelPolicies, rejectedImports, uiStates, runtimeStates };
  }

  function saveState(state) {
    writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, { ...state, validatorVersion: NATIVE_VALIDATOR_VERSION });
  }

  async function pushAccount(client, plan) {
    const response = await client.send(plan.request);
    let goRef = response.ok && response.data && response.data.account_ref ? String(response.data.account_ref) : '';
    if (!goRef && response.status === 409 && response.errorCode === 'account_conflict' && plan.predictedGoRef) {
      const existing = await client.getAccount(plan.predictedGoRef);
      if (existing.ok) goRef = plan.predictedGoRef;
    }
    if (!goRef) {
      return {
        goRef: '',
        status: response.status,
        error: response.errorCode || `http_${response.status}`,
        permanent: response.status === 422 && response.errorCode === PERMANENT_IMPORT_ERROR,
        settled: response.status === 409 && response.errorCode === SETTLED_IMPORT_ERROR
      };
    }
    return { goRef };
  }

  // 3b. 模型开关：失败的写保留在已推送集合里，下一轮继续对账。
  async function syncModelPolicies(client, state, nodeRefs, nodeAccounts, go, result) {
    const goRefByNodeRef = new Map();
    for (const [nodeRef, link] of Object.entries(state.links)) {
      if (nodeRefs.has(nodeRef)) goRefByNodeRef.set(nodeRef, link.goRef);
    }
    const plan = planModelPolicySync({
      settings: readModelSettings(aiHomeDir),
      nodeAccounts,
      goRefByNodeRef,
      goModelPolicies: go.modelPolicies,
      pushedKeys: state.modelPolicies
    });
    const next = new Set(plan.desiredKeys);
    for (const write of plan.writes) {
      const response = await client.setModelPolicy(write.accountRef, write.modelId, write.manualPolicy);
      if (response.ok) { result.modelPoliciesChanged += 1; continue; }
      if (write.manualPolicy === 'inherit') next.add(policyKey(write.accountRef, write.modelId));
      result.errors.push({ account_ref: write.accountRef, model: write.modelId, step: 'model_policy', error: response.errorCode });
    }
    state.modelPolicies = Array.from(next).sort();
  }

  // 3c. 账号页展示状态：Node 仍是写方，Go 持久化同一份投影（内容不变不重推）。
  async function syncUIStates(options) {
    const { client, state, nodeRefs, source, result } = options;
    const next = {};
    for (const record of source.accounts) {
      if (!nodeRefs.has(record.accountRef)) continue;
      const link = state.links[record.accountRef];
      if (!link || !link.goRef) continue;
      const ui = record.state || {};
      const body = {
        status: text(ui.status) || 'up',
        display_name: text(ui.displayName),
        auth_mode: text(ui.authMode),
        api_key_mode: ui.apiKeyMode === true,
        configured: ui.configured === true,
        base_url: '',
        updated_at: String(Number(ui.updatedAt) || Number(record.updatedAt) || 0)
      };
      const print = fingerprint(body);
      next[record.accountRef] = print;
      if (state.uiStates && state.uiStates[record.accountRef] === print) continue;
      const response = await client.putUIState(link.goRef, body);
      if (response.ok) {
        result.uiStatesChanged += 1;
      } else {
        delete next[record.accountRef];
        result.errors.push({ account_ref: record.accountRef, step: 'ui_state', error: response.errorCode || 'http_error' });
      }
    }
    state.uiStates = next;
  }

  // 3d. 账号级运行态：本进程的内存 Map 是权威值，Go 是持久化真相。
  // 迁移期先把旧列（account_state.runtime_state）里还没进 Go 的账号灌进 Map；
  // 之后 flush 只重试 dirty 条目，不需要再按内容指纹逐条比较。
  async function syncRuntimeStates(options) {
    const { nodeRefs, source, result, runtimeStates } = options;
    if (!runtimeStates) return;
    let bootstrapped = 0;
    for (const record of source.accounts) {
      if (!nodeRefs.has(record.accountRef)) continue;
      const legacy = record.state && record.state.runtimeState;
      if (!legacy || typeof legacy !== 'object') continue;
      if (runtimeStates.get(record.accountRef)) continue;
      const updatedAt = Number(record.state && record.state.updatedAt) || Date.now();
      if (runtimeStates.set(record.accountRef, legacy, updatedAt)) bootstrapped += 1;
    }
    const flushed = await runtimeStates.flush();
    const pushed = Number(flushed && flushed.pushed) || 0;
    result.runtimeStatesChanged += pushed + bootstrapped;
    if (flushed && flushed.failed > 0) {
      result.errors.push({ step: 'runtime_state', error: 'flush_failed', count: flushed.failed });
    }
  }

  // 4. 额度：Go 是存储真相（文档 + 归一化事实），Node 的 app_kv 只是可重建的读缓存。
  // 本地更新的文档推给 Go；Go 更新的文档回填本地缓存（换机/清库后可自愈）。
  // 同一份快照的归一化事实单独按 capturedAt 增量推送：它驱动 Go 的额度权重与阻塞判定。
  async function syncUsageDocuments(options) {
    const { client, state, nodeRefs, source, fs, aiHomeDir, result } = options;
    const response = await client.listUsageDocuments();
    if (!response.ok) {
      result.errors.push({ step: 'usage_documents', error: response.errorCode || 'http_error' });
      return;
    }
    const goByRef = new Map();
    for (const item of Array.isArray(response.data) ? response.data : []) {
      const accountRef = text(item && item.account_ref);
      if (accountRef) goByRef.set(accountRef, item);
    }
    const usageResponse = await client.listAccountUsage();
    const usageCapturedAt = new Map();
    if (usageResponse.ok) {
      for (const item of Array.isArray(usageResponse.data) ? usageResponse.data : []) {
        const accountRef = text(item && item.account_ref);
        if (accountRef) usageCapturedAt.set(accountRef, Number(item.captured_at_ms) || 0);
      }
    } else {
      result.errors.push({ step: 'usage_facts', error: usageResponse.errorCode || 'http_error' });
    }
    const credentialUpdatedAt = new Map();
    const providerByRef = new Map();
    for (const record of source.accounts) {
      credentialUpdatedAt.set(
        record.accountRef,
        Math.max(Number(record.envUpdatedAt) || 0, Number(record.nativeAuthUpdatedAt) || 0)
      );
      providerByRef.set(record.accountRef, text(record.provider));
    }
    const snapshots = readJsonValuesByPrefix(fs, aiHomeDir, USAGE_SNAPSHOT_PREFIX);
    for (const [nodeRef, link] of Object.entries(state.links)) {
      if (!nodeRefs.has(nodeRef)) continue;
      const goRef = text(link && link.goRef);
      if (!goRef) continue;
      const key = `${USAGE_SNAPSHOT_PREFIX}${nodeRef}`;
      const local = snapshots.get(key);
      const localCapturedAt = usageSnapshotCapturedAt(local);
      const remote = goByRef.get(goRef);
      const remoteCapturedAt = Number(remote && remote.captured_at_ms) || 0;
      // 采集时间早于当前凭据的快照属于上一个身份：Go 在轮换时已删除，不能再推回去。
      const localIsCurrent = localCapturedAt > 0 &&
        localCapturedAt > (credentialUpdatedAt.get(nodeRef) || 0);
      if (localIsCurrent && localCapturedAt > remoteCapturedAt) {
        const pushed = await client.putUsageDocument(goRef, {
          kind: text(local.kind),
          source: text(local.source),
          captured_at: String(localCapturedAt),
          payload: local
        });
        if (pushed.ok) {
          result.usageDocumentsPushed += 1;
        } else {
          result.errors.push({ account_ref: nodeRef, step: 'usage_document_push', error: pushed.errorCode || 'http_error' });
        }
      }
      if (localIsCurrent &&
          usageResponse.ok &&
          localCapturedAt > (usageCapturedAt.get(goRef) || 0)) {
        const facts = buildUsageFacts(local, { provider: providerByRef.get(nodeRef) });
        if (facts) {
          const pushed = await client.send({
            method: 'PUT',
            path: `/v1/management/accounts/${encodeURIComponent(goRef)}/usage`,
            body: facts
          });
          if (pushed.ok) {
            result.usageFactsPushed += 1;
          } else {
            result.errors.push({ account_ref: nodeRef, step: 'usage_facts_push', error: pushed.errorCode || 'http_error' });
          }
        }
      }
      if (remoteCapturedAt > localCapturedAt &&
          remote && remote.payload && typeof remote.payload === 'object' && !Array.isArray(remote.payload)) {
        writeJsonValue(fs, aiHomeDir, key, remote.payload);
        result.usageDocumentsPulled += 1;
      }
    }
  }

  async function reconcileOnce() {
    const client = getClient();
    if (!client) return { skipped: 'go_core_not_ready' };
    const result = { pulled: 0, pushed: 0, enabledChanged: 0, defaultsChanged: 0, modelPoliciesChanged: 0, uiStatesChanged: 0, runtimeStatesChanged: 0, usageDocumentsPushed: 0, usageDocumentsPulled: 0, usageFactsPushed: 0, probePushed: 0, routingExclusionsPushed: 0, deleted: 0, adopted: 0, unsupported: 0, skippedStaticDuplicates: 0, goOnly: [], errors: [] };
    const state = loadState();

    // 1. Go -> Node：只回写 Go 代际严格更新的凭据（CAS，失败即下一轮重试）。
    let source = readNode(aiHomeDir);
    let go = readGo(aiHomeDir);
    const goByRef = new Map(go.accounts.map((account) => [account.accountRef, account]));
    for (const record of source.accounts) {
      const link = state.links[record.accountRef];
      const goAccount = link && goByRef.get(link.goRef);
      if (!goAccount) continue;
      const next = newerGoNativeAuth(record, goAccount);
      if (next && compareAndSwapAccountNativeAuth(fs, aiHomeDir, record.accountRef, record, next)) result.pulled += 1;
    }
    if (result.pulled > 0) source = readNode(aiHomeDir);

    // 2. Node -> Go：内容指纹变化或 Go 缺失时才推送，稳态下零请求。
    const nodeRefs = new Set();
    // 参与启停/default/模型策略对账的 Node 账号：凭据能翻译成 Go 导入请求。
    // 是否推送成功不影响它——第 3 步只用 link 判断，见那里的说明。
    const importableRefs = new Set();
    // 链接改指新 Go 账号时记下旧 ref。它是本次同步的产物，若还有别的 link 指向就保留。
    const abandonedGoRefs = new Set();
    // 本轮在 Go 里新建的账号行：路由排除要重推（新行没有上一行的排除标记）。
    const createdGoRefs = new Set();
    for (const record of source.accounts) {
      nodeRefs.add(record.accountRef);
      const plan = translateNodeAccount(record);
      if (plan.kind !== 'import') {
        delete state.rejectedImports[record.accountRef];
        result.unsupported += 1;
        continue;
      }
      importableRefs.add(record.accountRef);
      const print = planFingerprint(plan);
      const rejection = state.rejectedImports[record.accountRef];
      if (rejection && rejection.print !== print) delete state.rejectedImports[record.accountRef];
      const link = state.links[record.accountRef];
      const previousGoRef = link && link.goRef;
      let goRef = previousGoRef;
      if (!goRef || !goByRef.has(goRef) || link.print !== print) {
        // 终态拒绝只在「同一份内容 + Go 侧目标仍在」时生效：内容变化或 Go 账号消失
        // 都必须重新尝试，否则缓存会永久挡住凭据更新或账号重建。
        const targetStillPresent = !rejection || !rejection.goRef || goByRef.has(rejection.goRef);
        if (rejection && rejection.print === print && targetStillPresent) {
          result.errors.push({ account_ref: plan.nodeRef, step: 'push', error: rejection.error, cached: true });
          continue;
        }
        // 已链接的静态凭据不能重新创建：Go 的身份含 base_url，编辑 URL 会派生出新
        // accountRef，旧账号随后被当成 Go 独有账号收养回 Node（账号页多出一个账号）。
        // 原地轮换保持 Go accountRef 不变。只有 Go 已没有该账号时才退回创建。
        const canRotate = Boolean(previousGoRef && goByRef.has(previousGoRef) && isStaticPlan(plan));
        let pushed = await pushAccount(
          client,
          canRotate ? rotateStaticCredentialPlan(plan, previousGoRef) : plan
        );
        if (!pushed.goRef && canRotate && pushed.status === 404) {
          pushed = await pushAccount(client, plan);
        }
        if (!pushed.goRef) {
          if (pushed.permanent || pushed.settled) {
            // 已知目标账号时记下 goRef，供下一轮判断 Go 侧账号是否还在。
            const settledRef = pushed.settled && goRef ? goRef : '';
            state.rejectedImports[record.accountRef] = settledRef
              ? { print, error: pushed.error, goRef: settledRef }
              : { print, error: pushed.error };
          }
          result.errors.push({ account_ref: plan.nodeRef, step: 'push', error: pushed.error });
          continue;
        }
        if (previousGoRef && previousGoRef !== pushed.goRef) abandonedGoRefs.add(previousGoRef);
        goRef = pushed.goRef;
        // goByRef 是本轮开始时的快照：不在里面说明这行是刚创建的（原地轮换的仍在）。
        if (!goByRef.has(goRef)) createdGoRefs.add(goRef);
        result.pushed += 1;
        delete state.rejectedImports[record.accountRef];
        state.links[record.accountRef] = { goRef, print };
      }
    }

    // 旧映射被替换后，旧 Go 账号不再属于任何 Node 账号。留着会在第 5 步被收养回来，
    // 所以立即删除；删除失败也不收养（同密钥守卫兜住下一轮）。
    if (abandonedGoRefs.size > 0) {
      const stillReferenced = new Set(Object.values(state.links).map((link) => link.goRef));
      for (const abandonedGoRef of abandonedGoRefs) {
        if (stillReferenced.has(abandonedGoRef) || !goByRef.has(abandonedGoRef)) continue;
        const response = await client.deleteAccount(abandonedGoRef);
        if (response.ok || response.status === 404) result.deleted += 1;
        else result.errors.push({ account_ref: abandonedGoRef, step: 'delete_abandoned', error: response.errorCode });
      }
    }

    // 3. 启停与默认账号以 Node 为准（同一 Go 身份以首个 Node 账号为主）。
    // 主账号集合只由「当前 link + Node 源账号」决定，与凭据推送成败无关：import 失败的
    // 账号（例如 cline import 500）只要 link 还在，enabled/default/模型策略仍按 Node 收敛。
    // 推送失败只影响凭据本身（下一轮重试），不会让账号从对账里消失。
    const primaryByGoRef = new Map();
    for (const record of source.accounts) {
      if (!importableRefs.has(record.accountRef)) continue;
      const link = state.links[record.accountRef];
      if (!link || !link.goRef || primaryByGoRef.has(link.goRef)) continue;
      primaryByGoRef.set(link.goRef, record);
    }
    go = readGo(aiHomeDir);
    const goNow = new Map(go.accounts.map((account) => [account.accountRef, account]));
    for (const [goRef, record] of primaryByGoRef) {
      const goAccount = goNow.get(goRef);
      // Gemini Vertex 占位账号只用于展示/导出，不能进 Go 路由池。
      const vertexPlaceholder = record.provider === 'gemini'
        && /^(1|true|yes|on)$/i.test(String(record.env && record.env.VERTEX_AI_PLACEHOLDER || '').trim());
      const enabled = vertexPlaceholder ? false : record.status !== 'down';
      if (!goAccount || goAccount.enabled === enabled) continue;
      const response = await client.setEnabled(goRef, enabled);
      if (response.ok) result.enabledChanged += 1;
      else result.errors.push({ account_ref: goRef, step: 'enabled', error: response.errorCode });
    }

    // 3b. 额度探针结果：Node 每轮探测后只把**变化**推给 Go。
    //
    // 探针跑在 Node（要读各家凭据、处理差异），Go 只落库；不推的话 Node 重启后
    // 账号页整列退回「未知」。按签名去重，避免每 30 秒重复写同一行。
    await pushAccountProbes({
      client,
      primaryByGoRef,
      probeState,
      pushedSignatures: pushedProbeSignatures,
      result
    });

    // 3b-2. 账号级路由排除：自定义上游账号不进 Go 的路由候选与模型目录，
    // 其余账号照常由 Go 服务（详见 pushAccountRoutingExclusions 的说明）。
    await pushAccountRoutingExclusions({
      client,
      primaryByGoRef,
      pushedSignatures: pushedRoutingSignatures,
      createdRefs: createdGoRefs,
      result
    });
    for (const [provider, nodeRef] of Object.entries(source.defaults)) {
      const link = state.links[nodeRef];
      const target = link && goNow.get(link.goRef);
      if (!target || !target.enabled || go.defaults[provider] === link.goRef) continue;
      const response = await client.setProviderDefault(provider, link.goRef);
      if (response.ok) result.defaultsChanged += 1;
      else result.errors.push({ provider, step: 'default', error: response.errorCode });
    }

    await syncModelPolicies(client, state, nodeRefs, source.accounts, go, result);

    // 4. 删除：Node 源账号已消失的 link 视为孤儿。Go 账号仍被其它 link 指向则只摘 link；
    //    否则删除 Go 账号，且只有删除成功（或 Go 已无此账号）才摘 link——删除失败时保留 link
    //    下一轮重试，绝不能让孤儿在下一轮被第 5 步当作「Go 独有账号」收养回 Node（复活已删账号）。
    for (const nodeRef of Object.keys(state.rejectedImports)) {
      if (!nodeRefs.has(nodeRef)) delete state.rejectedImports[nodeRef];
    }
    const liveGoRefs = new Set();
    for (const [nodeRef, link] of Object.entries(state.links)) if (nodeRefs.has(nodeRef)) liveGoRefs.add(link.goRef);
    for (const [nodeRef, link] of Object.entries(state.links)) {
      if (nodeRefs.has(nodeRef)) continue;
      if (liveGoRefs.has(link.goRef) || !goNow.has(link.goRef)) { delete state.links[nodeRef]; continue; }
      const response = await client.deleteAccount(link.goRef);
      if (response.ok || response.status === 404) {
        delete state.links[nodeRef];
        goNow.delete(link.goRef);
        result.deleted += 1;
      } else {
        result.errors.push({ account_ref: link.goRef, step: 'delete', error: response.errorCode });
      }
    }
    const linkedGoRefs = new Set(Object.values(state.links).map((link) => link.goRef));

    // 5. 收养：只读快照经凭据适配器回收进 Node，并立即建立 link。
    // 不调用已移除的 sub2api /export，也不为同一身份再次向 Go 导入。
    for (const account of goNow.values()) {
      if (linkedGoRefs.has(account.accountRef)) continue;
      // 同一把静态密钥已对应 Node 账号：这是旧 base_url 派生出来的 Go 投影，不是新账号。
      // 编辑 URL 后若旧 Go 账号没删干净，收养它就会在 Node 里凭空多出一个账号。
      if (findNodeAccountWithStaticSecret(source.accounts, account)) {
        result.skippedStaticDuplicates += 1;
        continue;
      }
      const adopted = adoptGoAccount(account, { fs, aiHomeDir, readNodeAccounts: readNode });
      if (adopted.kind === 'unsupported') { result.goOnly.push(account.accountRef); continue; }
      if (adopted.kind === 'adopted') {
        state.links[adopted.nodeRef] = { goRef: account.accountRef, print: planFingerprint(adopted.plan) };
        linkedGoRefs.add(account.accountRef);
        result.adopted += 1;
      } else {
        result.errors.push({ account_ref: account.accountRef, step: 'adopt_import', error: adopted.error });
      }
    }

    await syncUIStates({ client, state, nodeRefs, source, result });
    await syncRuntimeStates({ client, state, nodeRefs, source, result, runtimeStates });
    await syncUsageDocuments({ client, state, nodeRefs, source, fs, aiHomeDir, result });

    saveState(state);
    return result;
  }

  async function reconcile() {
    if (running) return running;
    running = reconcileOnce()
      .then((result) => { lastResult = { at: new Date().toISOString(), ...result }; return lastResult; })
      .catch((error) => {
        lastResult = { at: new Date().toISOString(), failed: true, error: String(error && error.message || error) };
        log.error(`\x1b[31m[aih:go-sync]\x1b[0m reconcile failed: ${lastResult.error}`);
        return lastResult;
      })
      .finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { reconcile(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    reconcile();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running;
  }

  return { reconcile, start, stop, status: () => lastResult };
}

module.exports = {
  NATIVE_VALIDATOR_VERSION,
  SYNC_STATE_KEY,
  createGoAccountSync,
  pushAccountProbes,
  pushAccountRoutingExclusions,
  planFingerprint,
  newerGoNativeAuth
};
