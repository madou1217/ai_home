'use strict';

const path = require('node:path');
const {
  ERROR_RULES_ENV_KEY,
  ERROR_RULE_GROUP_IDS_ENV_KEY,
  validateUpstreamErrorRules,
  readUpstreamErrorGroupIds
} = require('../account/upstream-error-rules');
const {
  readUpstreamErrorMappingGroups
} = require('./upstream-error-mapping-store');
const {
  hasUpstreamErrorRulesPayload,
  resolveRoutingRulesUpstreamRejection
} = require('./upstream-routing-rules-eligibility');
const {
  listAccountCredentialRecords,
  readAccountCredentialRecord,
  readAccountCredentials,
  writeAccountCredentials
} = require('./account-credential-store');
const { detectHostAccounts } = require('../account/host-account-detectors');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { defaultWebTerminalSessionKey, resolveTerminalTransport } = require('./webui-terminal-transport-policy');
const {
  configureApiKeyAccount,
  configureVertexAiAccount,
  getDefaultAuthMode,
  isSupportedAuthMode,
  normalizeAuthMode,
  serializeAuthJob,
  isSupportedAuthStrategy
} = require('./web-account-auth');
const { getProviderCredentialFacts } = require('../provider-catalog');
const { CLAUDE_CREDENTIAL_TYPES, getClaudeCredentialType, writeClaudeCredentialEnv } = require('../account/claude-credential');
const {
  ACCOUNT_EGRESS_BINDING_UNAVAILABLE,
  ACCOUNT_EGRESS_UNAVAILABLE,
  ZCODE_EGRESS_BINDING_UNAVAILABLE,
  ZCODE_EGRESS_UNAVAILABLE,
  launchAccountAppWithEgress,
  pickZcodeEgressDependencies
} = require('./zcode-egress-service');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord,
  removeLiveAccountRecord
} = require('./webui-account-live');
const {
  getApiKeyDisplayName
} = require('./account-display-identity');
const { validateCodexDesktopAccount } = require('./codex-desktop-account');
const { reloadCodexDesktopRuntime } = require('./codex-desktop-runtime-reload');
const { createAccountRemovalService } = require('../account/account-removal');
const agyWarmPool = require('./agy-warm-ls-pool');
const {
  clearDefaultAccountRef,
  clearDefaultProviderProfile,
  readDefaultAccountRef,
  writeDefaultAccountRef
} = require('../account/default-account-store');
const { landOnAihServerDefault } = require('../account/host-default-landing');
const { getAppInstallJobManager } = require('./webui-app-install-routes');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { evaluateDefaultAccountEligibility } = require('./account-default-eligibility');
const { revokeCodexHostGrant } = require('../account/codex-host-grant-revoke');
const { createWebUiAccountAppLauncher } = require('./webui-account-app-launcher');
const { isDesktopHost } = require('../runtime/host-capabilities');
const { callGoHost } = require('./webui-go-proxy');

const ACCOUNT_APP_STATE_CONFLICT_ERRORS = new Set([
  'agy_desktop_keychain_conflict',
  'agy_desktop_restart_required',
  'agy_desktop_auth_unavailable',
  'kimi_desktop_session_required',
  'kimi_desktop_session_seed_failed',
  'kimi_desktop_restart_failed',
  'zcode_native_proxy_marker_unrecognized'
]);

const ACCOUNT_APP_INTERNAL_ERRORS = new Set([
  'zcode_native_proxy_settings_failed',
  ACCOUNT_EGRESS_BINDING_UNAVAILABLE,
  ZCODE_EGRESS_BINDING_UNAVAILABLE
]);

const ACCOUNT_APP_SERVICE_UNAVAILABLE_ERRORS = new Set([
  'agy_desktop_process_probe_failed',
  'codebuddy_desktop_keychain_unavailable',
  ACCOUNT_EGRESS_UNAVAILABLE,
  ZCODE_EGRESS_UNAVAILABLE
]);

const ACCOUNT_APP_ERROR_MESSAGES = Object.freeze({
  workdir_not_found: '所选项目目录不存在或不是文件夹，未启动 CLI。',
  model_alias_target_provider_mismatch: '所选别名指向其他供应商，当前身份账号无法路由。请选择该账号支持的模型。',
  model_alias_lookup_failed: '读取模型别名失败，未启动 CLI。',
  agy_desktop_keychain_conflict: '检测到其他 Antigravity Desktop 实例。macOS Keychain 是全局凭据，请先关闭其他实例后再打开此账号。',
  agy_desktop_restart_required: '该账号的 Antigravity Desktop 仍在使用旧凭据，请关闭后重新打开以加载当前账号凭据。',
  agy_desktop_auth_unavailable: '当前账号没有可用的 Antigravity OAuth 凭据，未启动 Desktop。',
  agy_desktop_process_probe_failed: '无法确认 Antigravity Desktop 实例状态，为避免覆盖全局凭据已停止启动。',
  codebuddy_desktop_keychain_unavailable: '无法为该账号的 Desktop 准备 macOS 系统钥匙串，请确认当前用户有可用的默认钥匙串后重试。',
  kimi_desktop_session_required: '该账号尚未完成 Kimi Desktop 托管登录，请先扫码后再打开。',
  kimi_desktop_session_seed_failed: 'Kimi Desktop 登录态写入失败，未启动未登录的应用实例。',
  kimi_desktop_restart_failed: 'Kimi Desktop 登录态已准备，但旧实例未能结束；为保证同账号单实例，未启动新实例。',
  account_egress_binding_unavailable: '账号出口绑定无法读取，为避免直连降级，Desktop 未启动；现有客户端设置保持不变。',
  account_egress_unavailable: '账号出口当前不可用，为避免绕过绑定，Desktop 未启动；请检查出口设置里的代理地址、系统代理或外部 TUN 后重试。',
  zcode_egress_binding_unavailable: 'ZCode 出口绑定无法读取，为避免直连降级，Desktop 未启动；现有原生设置保持不变。',
  zcode_egress_unavailable: 'ZCode 账号出口当前不可用，为避免绕过绑定，Desktop 未启动；请检查出口设置里的代理地址、系统代理或外部 TUN 后重试。',
  zcode_native_proxy_marker_unrecognized: 'ZCode 出口 marker 无法识别，Desktop 未启动；为避免覆盖现有设置或绕过绑定，请检查账号投影目录。',
  zcode_native_proxy_settings_failed: 'ZCode 原生代理设置写入失败，未启动 Desktop；请检查账号投影目录权限或 setting.json 是否损坏。'
});

function resolveAccountAppErrorMessage(result = {}) {
  const error = String(result.error || '');
  return ACCOUNT_APP_ERROR_MESSAGES[error]
    || String(result.message || error);
}

function resolveAccountAppErrorStatus(result = {}, fallbackStatus = 400) {
  const error = String(result.error || '');
  if (error === 'account_not_found') return 404;
  if (
    error === 'account_unconfigured'
    || error === 'account_auth_invalid'
    || ACCOUNT_APP_STATE_CONFLICT_ERRORS.has(error)
  ) return 409;
  if (ACCOUNT_APP_SERVICE_UNAVAILABLE_ERRORS.has(error)) return 503;
  if (ACCOUNT_APP_INTERNAL_ERRORS.has(error)) return 500;
  return fallbackStatus;
}

const { invalidateModelCacheForAccountRefs, buildPendingOauthResponse, reloadRuntimeAccountsIfNeeded, parseAccountRoute, isSelfRelayBaseUrl, writeSelfRelayAccountRejected, resolveAiHomeDir, accountExists, goOnlyAccountExists, inferReauthAuthMode, buildCallbackErrorMessage } = require('./webui-account-routes-utils');
const { applyAliasPoolPreference, readAliasPoolParticipates } = require('../account/alias-pool-preference');
const { detectStoredApiKeyMode, buildPersistedAccountState, isPendingOauthStateRow,
  readGoUIStateFor
} = require('./webui-account-routes-state');
const {
  resolveCodexDesktopHookService,
  setCodexDesktopAccount,
  clearCodexDesktopAccount,
  getAppEntryDetector,
  matchRunningDesktopAccountPids,
  matchRunningCliAccountPids
} = require('./webui-account-routes-desktop');
const { emitAccountRefreshJobEvent, enqueueAuthInvalidReconcileIfNeeded, findRuntimeAccount, makeAccountRefreshJobId, pickBlockingStatusValue, serializeAccountRefreshJob, startAccountRefreshJob } = require('./webui-account-routes-refresh');
const { WEBUI_ACCOUNT_IMPORT_MAX_BYTES, accountImportJobs, findActiveAccountImportJob, serializeAccountImportJob, buildImportJobResponse, startAccountImportJob } = require('./webui-account-routes-import');
const { evictAgyWarmWriterBeforeDelete, hasActiveNativeAccountRun } = require('./webui-account-routes-delete');
const {
  detectDeletionBlockers,
  releaseDeletionBlockers
} = require('./account-deletion-occupancy');
const { proxyGo } = require('./webui-go-proxy');
const { publishAccountLifecycleEvent } = require('./account-lifecycle-bus');
const { openSseStream, writeSseJson } = require('./webui-sse-broadcaster');
const { createDesktopLoginQRCode, getDesktopLoginQRCodeStatus, writeDesktopSession } = require('./kimi-desktop-session');
const { fetchKimiPlanStats } = require('./kimi-plan-stats');
async function handleListAccountsRequest(ctx) {
  return handleListAccountsFastRequest(ctx);
}

async function handleDetectHostAccountsRequest(ctx) {
  const { fs, writeJson } = ctx;
  const aiHomeDir = resolveAiHomeDir(ctx);
  const hostHomeDir = resolveHostHomeDir({});
  const result = detectHostAccounts({ fs, aiHomeDir, hostHomeDir });
  if (!result.ok) {
    writeJson(ctx.res, 500, result);
    return true;
  }
  // 新登记的账号要立刻生效：运行时账号池按库重载一次（账号页由 SSE 自己刷新）。
  if (result.updated > 0) reloadRuntimeAccountsIfNeeded(ctx);
  writeJson(ctx.res, 200, result);
  return true;
}

async function handleGetAddJobRequest(ctx) {
  const {
    pathname, getAuthJobManager, readPersistedAuthJob, cleanupAuthJobArtifacts, deps, state, writeJson
  } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/);
  const job = getAuthJobManager(deps, state).getJob(matches[1]);
  if (job) {
    if (job.status !== 'running' && job.status !== 'succeeded' && typeof cleanupAuthJobArtifacts === 'function') {
      cleanupAuthJobArtifacts(job, deps, state);
    }
    writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(job) });
    return true;
  }
  // 内存里没有：进程重启后内存 Job 会被清空，回落到 Go 的持久化快照（只读）。
  // 这条路径只服务展示：recovered=true 提示前端"进程已重启，任务已中断"。
  const persisted = typeof readPersistedAuthJob === 'function'
    ? await readPersistedAuthJob(matches[1])
    : null;
  if (!persisted) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(persisted), recovered: true });
  return true;
}

async function handleCancelAddJobRequest(ctx) {
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/);
  const result = getAuthJobManager(deps, state).cancelJob(matches[1]);
  if (!result.ok) {
    if (result.code === 'job_not_found') {
      writeJson(ctx.res, 200, {
        ok: true,
        job: {
          id: matches[1],
          status: 'cancelled',
          authProgressState: 'cancelled',
          error: '授权流程已结束或已清理。'
        }
      });
      return true;
    }
    writeJson(ctx.res, 400, { ok: false, error: result.code || 'cancel_failed' });
    return true;
  }
  cleanupAuthJobArtifacts(result.job, deps, state);
  writeJson(ctx.res, 200, {
    ok: true,
    job: serializeAuthJob(result.job)
  });
  return true;
}

async function handleConfirmAddJobInstallRequest(ctx) {
  const { pathname, getAuthJobManager, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/install$/);
  const manager = getAuthJobManager(deps, state);
  if (!manager || typeof manager.confirmCliInstall !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'cli_install_unavailable' });
    return true;
  }
  const job = manager.getJob(matches[1]);
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  if (!job.installRequired || job.setupPhase !== 'awaiting-install-confirmation') {
    writeJson(ctx.res, 400, { ok: false, error: 'install_not_required', job: serializeAuthJob(job) });
    return true;
  }
  setImmediate(() => {
    manager.confirmCliInstall(matches[1]).catch(() => {});
  });
  writeJson(ctx.res, 202, { ok: true, job: serializeAuthJob(job) });
  return true;
}

// macOS 协议处理器转来的 zcode:// 回调（见 lib/cli/commands/zcode-url-router.js）。
//
// 判定归属：state 与**在途的 zcode 登录任务**匹配 → 由 aih 收尾（token 交换 + 注册）；
// 不匹配 → 回 { handled: false }，由协议处理器转发给 ZCode Desktop。
// 这样 aih 接管 zcode: 协议不会抢走桌面端的回调。
async function handleZcodeUrlCallbackRequest(ctx) {
  const { getAuthJobManager, deps, state, readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const url = String(payload && payload.url || '').trim();
  const state_ = String(payload && payload.state || '').trim();
  if (!url || !state_) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_callback_payload' });
    return true;
  }
  const manager = getAuthJobManager(deps, state);
  const job = manager && typeof manager.getRunningJob === 'function' ? manager.getRunningJob('zcode') : null;
  // 归属判定：只有「在途任务」且 state 完全一致才算 aih 的。
  // 不用 URL 前缀/端口判断 —— state 是 OAuth 流程的随机串，是唯一可靠依据。
  if (!job || String(job.oauthState || '') !== state_) {
    writeJson(ctx.res, 404, { ok: false, handled: false, error: 'no_matching_auth_job' });
    return true;
  }
  const result = await manager.completeBrowserOauthCallback(job.id, url);
  writeJson(ctx.res, result.ok ? 200 : 400, {
    ok: Boolean(result.ok),
    handled: true,
    ...(result.code ? { error: result.code } : {}),
    ...(result.job ? { job: serializeAuthJob(result.job) } : {})
  });
  return true;
}

async function handleCompleteAddJobCallbackRequest(ctx) {
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, readRequestBody, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/callback$/);
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const callbackUrl = String(payload && payload.callbackUrl || '').trim();
  if (!callbackUrl) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_callback_url' });
    return true;
  }

  const manager = getAuthJobManager(deps, state);
  if (!manager || typeof manager.completeBrowserOauthCallback !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'callback_forward_unavailable' });
    return true;
  }

  const result = await manager.completeBrowserOauthCallback(matches[1], callbackUrl);
  if (result.ok) {
    writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(result.job) });
    return true;
  }
  if (
    result.job
    && result.job.status !== 'running'
    && result.job.status !== 'succeeded'
    && typeof cleanupAuthJobArtifacts === 'function'
  ) {
    cleanupAuthJobArtifacts(result.job, deps, state);
  }

  const code = String(result.code || 'callback_forward_failed');
  const statusCode = code === 'job_not_found'
    ? 404
    : (code === 'callback_forward_failed' ? 502 : 400);
  writeJson(ctx.res, statusCode, {
    ok: false,
    error: code,
    code,
    message: buildCallbackErrorMessage(code),
    job: serializeAuthJob(result.job)
  });
  return true;
}

// POST /v0/webui/accounts/add/jobs/:jobId/local-import {sourceId}
// 从本机登录态完成一次等待中的登录任务（例如 Kiro IDE 的登录态），不需要用户粘贴任何东西。
async function handleLocalAuthImportRequest(ctx) {
  const { pathname, getAuthJobManager, deps, state, readRequestBody, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/local-import$/);
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const sourceId = String((payload && payload.sourceId) || '').trim();
  if (!sourceId) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_source_id' });
    return true;
  }
  const manager = getAuthJobManager(deps, state);
  if (!manager || typeof manager.completeLocalAuthImport !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'local_import_unavailable' });
    return true;
  }
  const result = await manager.completeLocalAuthImport(matches[1], sourceId);
  if (result.ok) {
    writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(result.job) });
    return true;
  }
  const code = String(result.code || 'local_import_failed');
  const statusCode = code === 'job_not_found' ? 404 : (code.startsWith('auth_source_unavailable') ? 409 : 400);
  writeJson(ctx.res, statusCode, {
    ok: false, error: code, code,
    message: String(result.message || ''),
    job: result.job ? serializeAuthJob(result.job) : null
  });
  return true;
}

// GET /v0/webui/accounts/provider-auth-sources?provider=<id>
// 认证来源链的解析结果：这台机器上「每个认证方式现在能用哪些来源、能不能装」。
// 界面据此渲染「从本机导入」与安装提示，不自己判断环境。
//
// 数据面已切 Go（/v1/management/webui/accounts/provider-auth-sources）：installable、
// alreadyImported、排序与分组都由 Go 装配，Node 只在中转层做两件事：
//   1. 插件来源只存在于 Node 插件运行时，Go 读不到——一旦某插件为该 Provider 声明了来源，
//      这个 Provider 必须继续用 Node 实现，否则插件提供的登录入口会凭空消失；
//   2. Go 不可用或形状不完整（旧版 Go 还没有 installable/alreadyImported）时回落到 Node，
//      绝不让「装上客户端就能导入」的提示因为一次管理面故障消失。
async function handleProviderAuthSourcesRequest(ctx) {
  const { url, writeJson } = ctx;
  const provider = String((url && url.searchParams && url.searchParams.get('provider')) || '').trim().toLowerCase();
  if (!provider) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_provider' });
    return true;
  }
  const aiHomeDir = resolveAiHomeDir(ctx);
  const pluginSources = await collectPluginAccountSources(ctx, provider, aiHomeDir);
  if (pluginSources) {
    const { describeAuthMethodsWithSources } = require('../account/auth-sources');
    const resolved = describeAuthMethodsWithSources(provider, {
      fs: ctx.fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: ctx.deps && ctx.deps.hostHomeDir },
      extraSources: pluginSources.sources
    });
    writeJson(ctx.res, 200, {
      ok: true,
      ...resolved,
      pluginWarnings: pluginSources.warnings,
      pluginGeneration: pluginSources.generation
    });
    return true;
  }
  const goResolved = await readGoProviderAuthSources(ctx, provider);
  if (goResolved) {
    writeJson(ctx.res, 200, goResolved);
    return true;
  }
  const { describeAuthMethodsWithSources } = require('../account/auth-sources');
  const resolved = describeAuthMethodsWithSources(provider, {
    // 传账号池：本机登录态已在账号池里的来源会被标成 account_already_registered（界面不显示）。
    fs: ctx.fs,
    aiHomeDir,
    hostCapabilitiesOptions: { hostHomeDir: ctx.deps && ctx.deps.hostHomeDir }
  });
  writeJson(ctx.res, 200, { ok: true, ...resolved });
  return true;
}

// collectPluginAccountSources 收集插件为该 Provider 声明的登录来源。
// 没有插件运行时、没有插件来源或插件调用失败都返回 null（此时 Go 的结论才完整）。
async function collectPluginAccountSources(ctx, provider, aiHomeDir) {
  let pluginAccount = null;
  try {
    const { peekPluginSystem } = require('../plugins/control/plugin-system');
    pluginAccount = peekPluginSystem(ctx.state)?.account || null;
  } catch (_error) {
    pluginAccount = null;
  }
  if (!pluginAccount) return null;
  try {
    const { collectPluginAuthSources } = require('../plugins/account/auth-sources');
    const collected = await collectPluginAuthSources(provider, pluginAccount, {
      fs: ctx.fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: ctx.deps && ctx.deps.hostHomeDir }
    });
    if (!collected || !Array.isArray(collected.sources) || collected.sources.length === 0) return null;
    return collected;
  } catch (_error) {
    return null;
  }
}

/**
 * 读 Go 的认证来源链。
 *
 * 形状必须完整才采信：旧版 Go 的 sources 里没有 installable / alreadyImported，
 * 直接转发会让「装上客户端就能导入」的入口消失，所以这里显式要求这两个键存在，
 * 缺一个就返回 null 由调用方回落 Node 实现。
 */
async function readGoProviderAuthSources(ctx, provider) {
  const { available, response } = await callGoHost(ctx, 'getProviderAuthSources', [provider]);
  if (!available || !response || response.ok !== true) return null;
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.ok !== true || data.provider !== provider) return null;
  if (!Array.isArray(data.methods)) return null;
  for (const method of data.methods) {
    if (!method || typeof method.authMode !== 'string' || !Array.isArray(method.sources)) return null;
    for (const source of method.sources) {
      if (!source || typeof source.id !== 'string') return null;
      if (!Object.prototype.hasOwnProperty.call(source, 'installable')) return null;
      if (!Object.prototype.hasOwnProperty.call(source, 'alreadyImported')) return null;
    }
  }
  return data;
}

// POST /v0/webui/accounts/local-import {provider, sourceId}
// 从本机登录态**直接建账号**（不开登录任务）：给认证方式不经过登录任务的 provider 用
// （它们的本机登录态就是完整投影，例如只有 api-key 的 provider）。
// 需要身份核验/换 token 的来源会声明 directImport=false，这里明确拒绝并让界面走登录任务入口。
async function handleLocalAuthSourceImportRequest(ctx) {
  const { readRequestBody, writeJson, deps } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const provider = String((payload && payload.provider) || '').trim().toLowerCase();
  const sourceId = String((payload && payload.sourceId) || '').trim();
  if (!provider || !sourceId) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const aliasPoolParticipates = readAliasPoolParticipates(payload);
  const { importLocalAuthSource } = require('../account/local-auth-import');
  // 注入点与 deps.fetch / deps.accountArtifactHooks 同形：测试用桩验证「成功导入后偏好落库」。
  const importLocalAuthSourceImpl = deps && typeof deps.importLocalAuthSource === 'function'
    ? deps.importLocalAuthSource
    : importLocalAuthSource;
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const { resolveAuthSourcesWithPlugins } = require('../plugins/account/auth-sources');
  const aiHomeDir = resolveAiHomeDir(ctx);
  const pluginAccount = peekPluginSystem(ctx.state)?.account || null;
  const resolved = pluginAccount
    ? await resolveAuthSourcesWithPlugins(provider, pluginAccount, {
      fs: ctx.fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: deps && deps.hostHomeDir }
    })
    : undefined;
  const result = await importLocalAuthSourceImpl({
    fs: ctx.fs,
    provider,
    sourceId,
    aiHomeDir,
    hostHomeDir: deps && deps.hostHomeDir,
    request: deps && deps.fetch,
    ...(resolved ? { resolved } : {})
  });
  if (!result.ok) {
    // 403：来源已知但不该从这里走（需要登录任务）；409：状态冲突（已入库/不可用）。
    const status = result.code === 'auth_source_requires_login_job' ? 403
      : (result.code === 'auth_source_unknown' || result.code === 'missing_provider' || result.code === 'missing_source_id' ? 400 : 409);
    writeJson(ctx.res, status, { ok: false, error: result.code, detail: result.detail || '' });
    return true;
  }
  // 「不入池」必须在重载运行池之前落库，否则这次重载会先把它拉进别名选号池。
  applyAliasPoolPreference(ctx.fs, aiHomeDir, result.accountRef, aliasPoolParticipates);
  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}
  const account = await refreshLiveAccountRecord(ctx, provider, result.accountRef, { skipUsageRefresh: true });
  writeJson(ctx.res, 200, {
    ok: true,
    provider,
    accountRef: result.accountRef,
    cliAccountId: result.cliAccountId,
    sourceId: result.sourceId,
    account
  });
  return true;
}

// POST /v0/webui/accounts/plugin-login/start {provider, sourceId}
// P4：插件提供的交互式登录（设备码 / 浏览器 / 粘贴凭据）。任务状态由宿主保存，
// 插件只返回公开状态与投影文件；凭据不进入任务列表/持久化文件。
async function handlePluginAccountLoginStartRequest(ctx) {
  const { readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const provider = String((payload && payload.provider) || '').trim().toLowerCase();
  const sourceId = String((payload && payload.sourceId) || '').trim();
  if (!provider || !sourceId) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const account = peekPluginSystem(ctx.state)?.account || null;
  if (!account) {
    writeJson(ctx.res, 503, { ok: false, error: 'plugin_runtime_inactive' });
    return true;
  }
  try {
    const job = await account.startLogin({ provider, sourceId });
    writeJson(ctx.res, 200, { ok: true, job });
  } catch (error) {
    const code = String(error && error.code || 'account_login_failed');
    const status = code === 'plugin_runtime_inactive' ? 503
      : (code === 'auth_source_unknown' ? 404 : (code === 'auth_source_unavailable' ? 409 : 400));
    writeJson(ctx.res, status, { ok: false, error: code, detail: String(error && error.message || '') });
  }
  return true;
}

async function handlePluginAccountLoginPollRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/plugin-login\/([^/]+)$/);
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const account = peekPluginSystem(ctx.state)?.account || null;
  if (!account) {
    writeJson(ctx.res, 503, { ok: false, error: 'plugin_runtime_inactive' });
    return true;
  }
  try {
    const job = await account.pollLogin(matches[1]);
    if (job && job.status === 'success') {
      try { reloadRuntimeAccountsIfNeeded(ctx, job.provider); } catch (_error) {}
      const record = await refreshLiveAccountRecord(ctx, job.provider, job.accountRef, { skipUsageRefresh: true });
      writeJson(ctx.res, 200, { ok: true, job, account: record });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, job });
  } catch (error) {
    const code = String(error && error.code || 'account_login_failed');
    const status = Number(error && error.statusCode) || (code === 'plugin_runtime_inactive' ? 503 : 400);
    writeJson(ctx.res, status, { ok: false, error: code, detail: String(error && error.message || '') });
  }
  return true;
}

async function handlePluginAccountLoginSubmitRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/plugin-login\/([^/]+)\/submit$/);
  const payload = await readRequestBody(ctx.req, { maxBytes: 128 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const value = String((payload && payload.value) || '');
  if (!value.trim()) {
    writeJson(ctx.res, 400, { ok: false, error: 'account_login_submit_value_required' });
    return true;
  }
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const account = peekPluginSystem(ctx.state)?.account || null;
  if (!account) {
    writeJson(ctx.res, 503, { ok: false, error: 'plugin_runtime_inactive' });
    return true;
  }
  try {
    const job = await account.submitLogin(matches[1], { value });
    if (job && job.status === 'success') {
      try { reloadRuntimeAccountsIfNeeded(ctx, job.provider); } catch (_error) {}
      const record = await refreshLiveAccountRecord(ctx, job.provider, job.accountRef, { skipUsageRefresh: true });
      writeJson(ctx.res, 200, { ok: true, job, account: record });
      return true;
    }
    writeJson(ctx.res, 200, { ok: true, job });
  } catch (error) {
    const code = String(error && error.code || 'account_login_submit_failed');
    const status = Number(error && error.statusCode)
      || (code === 'plugin_runtime_inactive' ? 503
        : (code === 'account_login_submit_unsupported' ? 409 : 400));
    writeJson(ctx.res, status, { ok: false, error: code, detail: String(error && error.message || '') });
  }
  return true;
}

async function handlePluginAccountLoginCancelRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/plugin-login\/([^/]+)\/cancel$/);
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const account = peekPluginSystem(ctx.state)?.account || null;
  if (!account) {
    writeJson(ctx.res, 503, { ok: false, error: 'plugin_runtime_inactive' });
    return true;
  }
  try {
    const job = await account.cancelLogin(matches[1]);
    writeJson(ctx.res, 200, { ok: true, job });
  } catch (error) {
    const code = String(error && error.code || 'account_login_cancel_failed');
    writeJson(ctx.res, Number(error && error.statusCode) || 400, { ok: false, error: code });
  }
  return true;
}

async function handleAddAccountRequest(ctx) {
  const {
    fs,
    deps,
    state,
    readRequestBody,
    accountStateService,
    getAuthJobManager,
    cleanupAuthJobArtifacts,
    writeJson
  } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.provider) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const provider = String(payload.provider || '').trim().toLowerCase();
  const defaultAuthMode = (payload.config && payload.config.apiKey) ? 'api-key' : getDefaultAuthMode(provider);
  const authMode = normalizeAuthMode(payload.authMode || defaultAuthMode);
  const authStrategy = String(payload.authStrategy || '').trim();
  const config = payload.config || {};
  const replaceExisting = Boolean(payload.replaceExisting);
  // 新增时的「是否进入别名自动选号池」偏好：缺省＝参与（见 lib/account/alias-pool-preference.js）。
  // api-key / vertex 立即建账号，这里直接落库；OAuth 登录任务要等作业成功才注册账号，
  // 偏好随作业带到 finalizeJob 落库。
  const aliasPoolParticipates = readAliasPoolParticipates(payload);
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!authMode) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_auth_mode' });
    return true;
  }
  if (!isSupportedAuthMode(provider, authMode)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_auth_mode' });
    return true;
  }
  if (!isSupportedAuthStrategy(provider, authMode, authStrategy)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_auth_strategy' });
    return true;
  }
  try {
    if (authMode === 'api-key' || authMode === 'auth-token') {
      if (isSelfRelayBaseUrl(provider, config.baseUrl, ctx)) {
        writeSelfRelayAccountRejected(ctx, provider);
        return true;
      }
      const configuredAccount = configureApiKeyAccount({
        fs,
        provider,
        aiHomeDir: resolveAiHomeDir(ctx),
        config: buildApiKeyAccountConfig(provider, config, authMode),
        accountArtifactHooks: ctx.deps && ctx.deps.accountArtifactHooks
      });
      const accountRef = configuredAccount.accountRef;
      const baseState = {
        status: 'up',
        configured: true,
        apiKeyMode: true,
        authMode,
        displayName: getApiKeyDisplayName(provider, config)
      };
      if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
        accountStateService.syncAccountBaseState(accountRef, provider, baseState);
      }
      // 「不入池」必须在重载运行池之前落库，否则这次重载会先把它拉进别名选号池。
      applyAliasPoolPreference(fs, resolveAiHomeDir(ctx), accountRef, aliasPoolParticipates);
      try {
        reloadRuntimeAccountsIfNeeded(ctx, provider);
      } catch (_error) {}
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, { skipUsageRefresh: true });
      writeJson(ctx.res, 200, { ok: true, provider, accountRef, authMode, status: 'configured', account });
      return true;
    }

    if (authMode === 'vertex-ai') {
      const configuredAccount = configureVertexAiAccount({
        fs,
        provider,
        aiHomeDir: resolveAiHomeDir(ctx),
        config,
        accountArtifactHooks: ctx.deps && ctx.deps.accountArtifactHooks
      });
      const accountRef = configuredAccount.accountRef;
      const baseState = {
        status: 'up',
        configured: true,
        apiKeyMode: true,
        authMode,
        displayName: (config && config.displayName) || `Vertex AI (${(config && config.projectId) || '占位'})`
      };
      if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
        accountStateService.syncAccountBaseState(accountRef, provider, baseState);
      }
      applyAliasPoolPreference(fs, resolveAiHomeDir(ctx), accountRef, aliasPoolParticipates);
      try {
        reloadRuntimeAccountsIfNeeded(ctx, provider);
      } catch (_error) {}
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, { skipUsageRefresh: true });
      writeJson(ctx.res, 200, { ok: true, provider, accountRef, authMode, status: 'configured', account, placeholder: true });
      return true;
    }

    const manager = getAuthJobManager(deps, state);
    if (replaceExisting) {
      const activeJob = manager.getRunningJob(provider);
      if (activeJob) {
        manager.cancelJob(activeJob.id);
        cleanupAuthJobArtifacts(activeJob, deps, state);
      }
    }
    const started = typeof manager.startOauthJobWithInstallConfirmation === 'function'
      ? manager.startOauthJobWithInstallConfirmation(provider, authMode, {
        // kiro 的 social 设备流（Google / Github）由这个字段选择；缺省 = Builder ID 的 OIDC 口径。
        loginProvider: String((config && config.loginProvider) || payload.loginProvider || '').trim(),
        authStrategy,
        // 账号要等作业成功才注册，偏好由作业带到 finalizeJob 落库。
        aliasPoolParticipates
      })
      : manager.startOauthJob(provider, authMode);
    writeJson(ctx.res, 200, buildPendingOauthResponse(started, authMode, authStrategy));
    return true;
  } catch (error) {
    const msg = String((error && error.message) || error || 'unknown');
    const code = String(error && error.code || '');
    const statusCode = (
      code === 'unsupported_provider'
      || code === 'unknown_cli'
      || code === 'missing_credential'
      || code === 'base_url_unsupported'
      || code === 'invalid_base_url'
      || code === 'invalid_auth_mode'
      || code === 'unsupported_auth_mode'
      || code === 'unsupported_auth_strategy'
      || code === 'gemini_google_oauth_disabled'
    ) ? 400 : (code === 'oauth_job_already_running' ? 409 : 500);
    const response = { ok: false, error: 'add_account_failed', code, message: msg };
    if (code === 'oauth_job_already_running') {
      const activeJob = getAuthJobManager(deps, state).getRunningJob(provider);
      response.jobId = String((error && error.jobId) || (activeJob && activeJob.id) || '');
      response.accountRef = String((activeJob && activeJob.accountRef) || '');
    }
    // Surface auto-install attempts so WebUI can show closed-loop progress.
    if (code === 'cli_not_found' && error && Array.isArray(error.installAttempts)) {
      response.installAttempts = error.installAttempts.map((item) => ({
        id: String(item && item.id || ''),
        label: String(item && item.label || ''),
        ok: Boolean(item && item.ok),
        error: String(item && item.error || '').slice(0, 500)
      }));
    }
    writeJson(ctx.res, statusCode, response);
    return true;
  }
}

async function handleReauthAccountRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    getAuthJobManager,
    deps,
    state,
    writeJson
  } = ctx;

  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/reauth$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  // Go 独有账号：Node 账号库没有、Go 有。重新登录本来就由 Go 的 OAuth Job 承接，
  // Node 只负责起作业与推进进度。
  const goOnlyReauth = !accountExists(ctx, provider, accountRef);
  if (goOnlyReauth && !goOnlyAccountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  if (!goOnlyReauth && detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'reauth_unsupported',
      code: 'api_key_reauth_unsupported',
      message: 'API Key 账号不支持重新认证，请直接更新密钥。'
    });
    return true;
  }

  let authMode = inferReauthAuthMode(provider, stateRow);
  if (!authMode) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'reauth_unsupported',
      code: 'unsupported_auth_mode',
      message: '当前账号无法推断认证方式，请删除后重新添加。'
    });
    return true;
  }
  if (hasActiveNativeAccountRun(ctx, provider, accountRef)) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: '请先停止该账号正在运行的会话，再删除账号。'
    });
    return true;
  }
  const lifecycle = getAccountLifecycle(provider);
  if (lifecycle && typeof lifecycle.evictWarmRuntime === 'function'
    && !(await lifecycle.evictWarmRuntime(accountRef))) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: 'Antigravity 后台进程尚未退出，请稍后重试。'
    });
    return true;
  }
  try {
    const liveStatus = deps && typeof deps.checkStatus === 'function'
      ? (deps.checkStatus(provider, accountRef) || {})
      : {};
    const previousAccountState = {
      displayName: String(liveStatus.accountName || (stateRow && stateRow.displayName) || '').trim(),
      email: String((stateRow && stateRow.email) || liveStatus.email || '').trim()
    };
    const started = getAuthJobManager(deps, state).startOauthJob(provider, authMode, { accountRef, previousAccountState });
    const accountLabel = String(
      (previousAccountState && (previousAccountState.displayName || previousAccountState.email))
      || accountRef
    ).trim();
    writeJson(ctx.res, 200, { ...buildPendingOauthResponse(started, authMode), accountLabel, accountRef });
    return true;
  } catch (error) {
    const msg = String((error && error.message) || error || 'unknown');
    const code = String(error && error.code || '');
    const statusCode = code === 'oauth_job_already_running' ? 409 : 500;
    const response = { ok: false, error: 'reauth_account_failed', code, message: msg };
    if (code === 'oauth_job_already_running') {
      const activeJob = getAuthJobManager(deps, state).getRunningJob(provider);
      response.jobId = String((error && error.jobId) || (activeJob && activeJob.id) || '');
      response.accountRef = String((activeJob && activeJob.accountRef) || '');
    }
    writeJson(ctx.res, statusCode, response);
    return true;
  }
}

// ── Go 异步额度刷新（refresh-usage）─────────────────────────────────────────
// Go 把额度探测包成异步作业：202 返回 queued 的 job，状态靠 refresh-jobs 轮询推进。
// Node 只做契约翻译：先回 202 让前端挂上 SSE，再把作业状态变化推成 account-refresh-job。
const GO_USAGE_REFRESH_POLL_INTERVAL_MS = 300;
const GO_USAGE_REFRESH_POLL_TIMEOUT_MS = 30 * 1000;

// 只有「Go 没有这条路由」或「Go 根本连不上」才退回 Node 本地探测。
// timeout 刻意不在名单里：请求已被 Go 接受，本地再探一次会重复打上游。
const GO_USAGE_REFRESH_FALLBACK_CODES = new Set([
  'go_core_unavailable',
  'network_error',
  'http_404',
  'http_405',
  'http_501'
]);

function shouldFallbackToLocalUsageRefresh(result) {
  if (!result) return true;
  const errorCode = String(result.errorCode || '').trim();
  if (errorCode === 'timeout') return false;
  if (errorCode && GO_USAGE_REFRESH_FALLBACK_CODES.has(errorCode)) return true;
  return Number(result.status) === 0;
}

function readGoUsageRefreshError(result) {
  const data = result && result.data;
  const message = String(
    (data && (data.message || data.error)) || (result && result.errorCode) || ''
  ).trim();
  return message || 'go_refresh_failed';
}

// 本地合成的失败终态：Go 明确失败（含 timeout）时用它收尾，避免界面一直转圈。
function buildFailedUsageRefreshJob(provider, accountRef, message) {
  const now = Date.now();
  return {
    id: makeAccountRefreshJobId(provider, accountRef),
    provider: String(provider || '').trim().toLowerCase(),
    accountRef: String(accountRef || '').trim(),
    status: 'failed',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    error: String(message || 'go_refresh_failed').slice(0, 500)
  };
}

function delayUsageRefreshPoll(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 轮询计时器不作为进程存活理由（与服务内其它后台计时器一致）。
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// 轮询 Go 作业并把状态变化推成 SSE；终态成功后让账号读模型从规范源重取一次。
// 只在状态变化时推事件（queued → running → 终态），不按轮询节奏刷屏。
async function trackGoAccountRefreshJob(ctx, initialJob) {
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  const jobId = String((initialJob && initialJob.id) || '').trim();
  if (!jobId || !goHost || typeof goHost.getRefreshJob !== 'function') return;
  const deadline = Date.now() + GO_USAGE_REFRESH_POLL_TIMEOUT_MS;
  let job = initialJob;
  let lastStatus = String(job.status || '');
  while (lastStatus !== 'succeeded' && lastStatus !== 'failed' && Date.now() < deadline) {
    await delayUsageRefreshPoll(GO_USAGE_REFRESH_POLL_INTERVAL_MS);
    let polled = null;
    try {
      polled = await goHost.getRefreshJob(jobId);
    } catch (_error) {
      polled = null;
    }
    // 单次查询失败（Go 重启、作业过期）不当作终态，继续轮询到上限。
    const next = polled && polled.ok && polled.data ? polled.data.job : null;
    if (!next) continue;
    job = next;
    const status = String(job.status || '');
    if (status === lastStatus) continue;
    lastStatus = status;
    emitAccountRefreshJobEvent(ctx, job);
  }
  if (lastStatus !== 'succeeded' && lastStatus !== 'failed') {
    const now = Date.now();
    emitAccountRefreshJobEvent(ctx, { ...job, status: 'failed', error: '刷新超时', updatedAt: now, finishedAt: now });
    return;
  }
  if (lastStatus === 'succeeded') {
    try {
      // 额度快照已由 Go 落库，这里只需要让 Node 的账号读模型丢掉派生缓存重取一次。
      await require('./webui-account-live').__private
        .refreshAccountsFromCanonicalSource(ctx, { force: true });
    } catch (_error) {}
  }
}

async function handleRefreshAccountUsageRequest(ctx) {
  const {
    pathname,
    deps,
    accountStateIndex,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh-usage$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  // Go 独有账号：Node 账号库没有、Go 有。额度刷新本来就由 Go 执行，Node 只放行。
  const goOnly = !accountExists(ctx, provider, accountRef);
  if (goOnly && !goOnlyAccountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (!goOnly && detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    enqueueAuthInvalidReconcileIfNeeded(ctx, provider, accountRef, stateRow);
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'refresh_usage_unsupported',
      code: 'api_key_usage_refresh_unsupported',
      message: 'API Key 账号不支持额度刷新。'
    });
    return true;
  }

  // Go 优先：Go 的 refresh-usage 已是异步作业（202 + job + SSE），与公开契约同形。
  // 只有拿不到作业且属于「Go 没有这条路由 / 连不上」时才退回 Node 本地探测。
  const goHost = deps && deps.goCoreSync;
  if (goHost && typeof goHost.refreshAccountUsageWebUI === 'function') {
    let goResult = null;
    try {
      goResult = await goHost.refreshAccountUsageWebUI(provider, accountRef);
    } catch (_error) {
      // 客户端抛错说明请求没被 Go 接受，按「不可用」退回本地。
      goResult = { ok: false, status: 0, data: null, errorCode: '' };
    }
    const goJob = goResult && goResult.ok && goResult.data && goResult.data.job
      ? goResult.data.job
      : null;
    if (goJob) {
      emitAccountRefreshJobEvent(ctx, goJob);
      writeJson(ctx.res, 202, {
        ok: true,
        accepted: true,
        alreadyRunning: Boolean(goResult.data.alreadyRunning),
        // 与本地路径同一序列化口径：usage 作业不输出 scope/branches，前端两条路径形状一致。
        job: serializeAccountRefreshJob(goJob)
      });
      trackGoAccountRefreshJob(ctx, goJob).catch(() => {});
      return true;
    }
    if (!shouldFallbackToLocalUsageRefresh(goResult)) {
      // Go 已受理但没有作业可跟（timeout / 业务拒绝）：不重复探测上游，直接落失败终态。
      const failedJob = buildFailedUsageRefreshJob(
        provider,
        accountRef,
        goResult && goResult.errorCode === 'timeout' ? '刷新超时' : readGoUsageRefreshError(goResult)
      );
      emitAccountRefreshJobEvent(ctx, failedJob);
      writeJson(ctx.res, 202, { ok: true, accepted: true, alreadyRunning: false, job: serializeAccountRefreshJob(failedJob) });
      return true;
    }
  }

  if (goOnly) {
    // 本地探测需要 Node 凭据；Go 独有账号的凭据只在 Go 库里，直接落失败终态。
    const failedJob = buildFailedUsageRefreshJob(provider, accountRef, 'Go Core 不可用，无法刷新该账号额度');
    emitAccountRefreshJobEvent(ctx, failedJob);
    writeJson(ctx.res, 202, { ok: true, accepted: true, alreadyRunning: false, job: serializeAccountRefreshJob(failedJob) });
    return true;
  }

  try {
    const started = startAccountRefreshJob(ctx, provider, accountRef);
    writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: started.alreadyRunning,
      job: serializeAccountRefreshJob(started.job)
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'refresh_usage_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

// POST /v0/webui/accounts/kimi/:accountRef/desktop-session/start
// 发起 kimi 桌面版托管登录：创建官方登录 QR（微信扫码确认）。
function buildKimiDesktopSessionRequestDeps(ctx, accountRef) {
  const deps = ctx.deps || {};
  return {
    fs: ctx.fs,
    aiHomeDir: resolveAiHomeDir(ctx),
    accountRef,
    processObj: deps.processObj,
    fetchImpl: deps.fetchImpl,
    fetchWithTimeout: deps.fetchWithTimeout,
    resolveAccountEgressRequestOptions: deps.resolveAccountEgressRequestOptions,
    accountEgressDeps: deps.accountEgressDeps || pickZcodeEgressDependencies(deps),
    proxyUrl: ctx.options && ctx.options.proxyUrl,
    noProxy: ctx.options && ctx.options.noProxy
  };
}

// 账号子路由的 provider 作用域（**数据**，不是派发分支）：每个 handler 声明自己服务哪些
// provider，路由层用同一守卫拒绝其它 provider。新增 provider 支持只改这里的一行数据。
// 将来 Go 合同为这些能力（kimi 的桌面端会话 / 套餐统计）声明能力位后，这里应改为按能力查询。
const ACCOUNT_ROUTE_SCOPES = Object.freeze({
  'desktop-session/start': Object.freeze({ providers: ['kimi'] }),
  'desktop-session/poll': Object.freeze({ providers: ['kimi'] }),
  'desktop-session/watch': Object.freeze({ providers: ['kimi'] }),
  'plan-stats': Object.freeze({ providers: ['kimi'] }),
  // codex 桌面端（ChatGPT App）账号切换：只有 codex 有这个概念。
  'set-mobile': Object.freeze({ providers: ['codex'], error: 'mobile_account_unsupported' }),
  'clear-mobile': Object.freeze({ providers: ['codex'], error: 'mobile_account_unsupported' })
});

function requireAccountRouteScope(ctx, provider, scope) {
  const entry = ACCOUNT_ROUTE_SCOPES[scope] || {};
  const allowed = entry.providers || [];
  if (allowed.includes(provider)) return true;
  ctx.writeJson(ctx.res, 400, { ok: false, error: entry.error || 'unsupported_provider' });
  return false;
}

// provider 的**账号生命周期钩子**（数据）：哪些 provider 在停用/删除/清除默认/重新登录时需要
// 额外动作（回收宿主直连授权、重载桌面端 runtime、驱逐后台进程、API Key 账号配置形状）。
// 派发处只按 provider 取条目，不写 provider 名比较。
const ACCOUNT_LIFECYCLE = Object.freeze({
  codex: {
    revokeHostGrant: (ctx, accountRef) => revokeCodexHostGrantForAccount(ctx, accountRef),
    reloadDesktopRuntime: (ctx) => reloadCodexDesktopRuntime(resolveCodexDesktopHookService(ctx))
  },
  claude: {
    // Claude 的认证方式是凭据信封里的字段。
    apiKeyAccountConfig: (config, authMode) => ({ ...config, credentialType: authMode })
  },
  agy: {
    // agy 有常驻后台进程，重新登录前必须先驱逐。
    evictWarmRuntime: (accountRef) => agyWarmPool.evict(accountRef)
  }
});

function getAccountLifecycle(provider) {
  return ACCOUNT_LIFECYCLE[String(provider || '').trim().toLowerCase()] || null;
}

// 回收宿主直连授权（没有该钩子的 provider 返回 null，调用方原样忽略）。
function revokeHostGrantHook(ctx, provider, accountRef) {
  const hook = getAccountLifecycle(provider);
  if (!hook || typeof hook.revokeHostGrant !== 'function') return null;
  try {
    return hook.revokeHostGrant(ctx, accountRef);
  } catch (error) {
    return { ok: false, revoked: false, reason: 'host_grant_revoke_failed', message: String((error && error.message) || error) };
  }
}

function reloadDesktopRuntimeHook(ctx, provider) {
  const hook = getAccountLifecycle(provider);
  if (!hook || typeof hook.reloadDesktopRuntime !== 'function') return null;
  return hook.reloadDesktopRuntime(ctx);
}

function buildApiKeyAccountConfig(provider, config, authMode) {
  const hook = getAccountLifecycle(provider);
  return hook && typeof hook.apiKeyAccountConfig === 'function'
    ? hook.apiKeyAccountConfig(config, authMode)
    : config;
}

async function handleKimiDesktopSessionStartRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/start$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/start')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const result = await createDesktopLoginQRCode(
    buildKimiDesktopSessionRequestDeps(ctx, accountRef)
  ).catch((error) => ({ ok: false, error: `create_qrcode_failed:${String(error && error.message || error).slice(0, 120)}` }));
  if (!result.ok) {
    writeJson(ctx.res, 502, { ok: false, error: result.error });
    return true;
  }
  writeJson(ctx.res, 200, {
    ok: true,
    code: result.code,
    qrUrl: result.qrUrl,
    expiresAtMs: result.expiresAtMs
  });
  return true;
}

// POST /v0/webui/accounts/kimi/:accountRef/desktop-session/poll {code}
// 轮询扫码状态；SUCCESS 时把 web session 托管进 nativeAuth.desktopSession。
async function handleKimiDesktopSessionPollRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/poll$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/poll')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const code = String(payload && payload.code || '').trim();
  if (!code) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_code' });
    return true;
  }
  const result = await getDesktopLoginQRCodeStatus(
    buildKimiDesktopSessionRequestDeps(ctx, accountRef),
    code
  ).catch((error) => ({ ok: false, error: `qrcode_status_failed:${String(error && error.message || error).slice(0, 120)}` }));
  if (!result.ok) {
    writeJson(ctx.res, 502, { ok: false, error: result.error });
    return true;
  }
  if (result.status === 'STATUS_SUCCESS') {
    const stored = writeDesktopSession(ctx.fs, resolveAiHomeDir(ctx), accountRef, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.userId
    });
    if (!stored) {
      writeJson(ctx.res, 500, { ok: false, error: 'desktop_session_store_failed' });
      return true;
    }
  }
  writeJson(ctx.res, 200, { ok: true, status: result.status });
  return true;
}

// GET /v0/webui/accounts/kimi/:accountRef/desktop-session/watch?code=...
// SSE 桥：服务端按 2s 查官方 QR 状态（上游只有轮询接口），WebUI 只收事件。
async function handleKimiDesktopSessionWatchRequest(ctx) {
  const { pathname, url, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/watch$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/watch')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const code = String((url && url.searchParams && url.searchParams.get('code')) || '').trim();
  if (!code) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_code' });
    return true;
  }
  openSseStream(ctx.res);
  let stopped = false;
  let timer = null;
  const cleanup = () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  if (ctx.req && typeof ctx.req.on === 'function') ctx.req.on('close', cleanup);
  if (ctx.res && typeof ctx.res.on === 'function') ctx.res.on('close', cleanup);

  const tick = async () => {
    if (stopped) return;
    const result = await getDesktopLoginQRCodeStatus(
      buildKimiDesktopSessionRequestDeps(ctx, accountRef),
      code
    ).catch((error) => ({ ok: false, error: 'qrcode_status_failed:' + String((error && error.message) || error).slice(0, 120) }));
    if (stopped) return;
    if (!result.ok) {
      writeSseJson(ctx.res, { type: 'error', error: result.error });
      cleanup();
      ctx.res.end();
      return;
    }
    if (result.status === 'STATUS_SUCCESS') {
      const stored = writeDesktopSession(ctx.fs, resolveAiHomeDir(ctx), accountRef, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId
      });
      if (!stored) {
        writeSseJson(ctx.res, { type: 'error', error: 'desktop_session_store_failed' });
        cleanup();
        ctx.res.end();
        return;
      }
    }
    writeSseJson(ctx.res, { type: 'status', status: result.status });
    if (result.status === 'STATUS_SUCCESS' || result.status === 'STATUS_EXPIRED') {
      cleanup();
      ctx.res.end();
      return;
    }
    timer = setTimeout(tick, 2000);
    if (typeof timer.unref === 'function') timer.unref();
  };
  void tick();
  return true;
}

// GET /v0/webui/accounts/kimi/:accountRef/plan-stats[?refresh=1]
// 读取 kimi 套餐配额（月度总量/5h/7d/Gift），数据来自桌面端托管 Web session 的
// 官方 Membership RPC；未授权桌面端时返回 400 + code=desktop_session_missing。
async function handleKimiPlanStatsRequest(ctx) {
  const { pathname, url, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/plan-stats$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'plan-stats')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const refresh = !!(url && url.searchParams && url.searchParams.get('refresh') === '1');
  const result = await fetchKimiPlanStats(
    buildKimiDesktopSessionRequestDeps(ctx, accountRef),
    { refresh }
  ).catch((error) => ({ ok: false, error: `plan_stats_failed:${String(error && error.message || error).slice(0, 120)}` }));
  if (!result.ok) {
    if (result.error === 'desktop_session_missing') {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'desktop_session_missing',
        code: 'desktop_session_missing',
        message: '该账号尚未完成桌面端授权，无法读取套餐配额。'
      });
      return true;
    }
    writeJson(ctx.res, result.auth ? 401 : 502, { ok: false, error: result.error });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, stats: result.stats, cached: result.cached === true });
  return true;
}

async function handleOpenAccountAppRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/open-app$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const kind = String(payload && payload.kind || '').trim().toLowerCase();
  const action = String(payload && payload.action || 'open').trim().toLowerCase();
  const terminalId = String(payload && payload.terminalId || '').trim().toLowerCase();
  const workdir = String(payload && payload.workdir || '').trim();
  const harness = String(payload && payload.harness || '').trim().toLowerCase();
  const model = String(payload && payload.model || '').trim();
  const requestedTransport = String(payload && payload.transport || '').trim().toLowerCase();
  const sessionKey = String(payload && payload.sessionKey || '').trim();
  // 浏览器不在 Server 本机（或 Server 无桌面）时，原生终端窗口开在用户看不到的地方：
  // CLI 一律改走 Web Terminal（Server 端 PTY）。客户端只能降级到 webui，不能反向升级。
  const transport = kind === 'cli'
    ? resolveTerminalTransport({
      req: ctx.req,
      requested: requestedTransport,
      processObj: ctx.processObj || ctx.deps && ctx.deps.processObj || process,
      env: ctx.env || ctx.deps && ctx.deps.env
    })
    : requestedTransport;
  const effectiveSessionKey = kind === 'cli' && transport === 'webui' && !sessionKey
    ? defaultWebTerminalSessionKey({ accountRef: parsed.accountRef, harness, model, workdir })
    : sessionKey;

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (kind === 'desktop') {
    const processObj = ctx.processObj || ctx.deps && ctx.deps.processObj || process;
    const env = ctx.env || ctx.deps && ctx.deps.env || processObj.env || {};
    if (!isDesktopHost({ platform: processObj.platform, env })) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'desktop_unavailable_on_server',
        message: '当前 AIH Server 没有桌面会话；请使用 Web 虚拟终端或 SSH 开发机。'
      });
      return true;
    }
  }
  const routeDeps = ctx.deps || {};

  const launcher = createWebUiAccountAppLauncher(ctx, provider, accountRef, action);
  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: { provider, accountRef, kind, action, terminalId, workdir, harness, model, transport, sessionKey: effectiveSessionKey },
    egressInput: {
      fs: ctx.fs,
      aiHomeDir: resolveAiHomeDir(ctx),
      processObj: ctx.processObj || routeDeps.processObj || process,
      deps: pickZcodeEgressDependencies(routeDeps)
    }
  });
  const { result } = launch;
  const egressWarning = String(launch.egressWarning || '');
  if (egressWarning) {
    console.warn(`\x1b[33m[aih:webui]\x1b[0m ${provider}/${accountRef} ${egressWarning}`);
  }
  if (!result.ok) {
    const isInstallMissing = action === 'open'
      && transport !== 'webui'
      && (result.error === 'desktop_not_installed' || result.error === 'cli_not_installed');
    if (isInstallMissing) {
      const manager = getAppInstallJobManager(ctx);
      // 跨 Provider 时缺的是 harness 的二进制，不是身份账号 provider 的。
      const installProvider = kind === 'cli' && harness ? harness : provider;
      const installTarget = {
        provider: installProvider,
        kind,
        appId: kind === 'desktop' ? `${provider}-desktop` : installProvider
      };
      const installAvailable = manager && typeof manager.canInstall === 'function'
        ? manager.canInstall(installTarget)
        : Boolean(manager && typeof manager.start === 'function');
      writeJson(ctx.res, 428, {
        ok: false,
        error: 'install_required',
        installRequired: true,
        installTarget,
        installAvailable,
        message: installAvailable
          ? (kind === 'desktop'
            ? '未检测到 Desktop 应用，请确认后开始安装。'
            : '未检测到原生 CLI，请确认后开始安装。')
          : (kind === 'desktop'
            ? '当前平台没有可用的自动安装器，请手动安装官方 Desktop 应用后重试。'
            : '当前 Provider 没有可用的自动安装器，请手动安装原生 CLI 后重试。')
      });
      return true;
    }
    const statusCode = resolveAccountAppErrorStatus(result, 400);
    const message = resolveAccountAppErrorMessage(result);
    writeJson(ctx.res, statusCode, {
      ok: false,
      error: result.error,
      message,
      ...(Array.isArray(result.pids) ? { pids: result.pids } : {}),
      ...(result.reason ? { reason: String(result.reason) } : {}),
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
      ...(result.egressError ? { egressError: String(result.egressError) } : {}),
      ...(egressWarning ? { egressWarning } : {})
    });
    return true;
  }
  writeJson(ctx.res, 200, {
    ok: true,
    provider,
    accountRef,
    kind,
    status: String(result.status || ''),
    pid: Number.isFinite(result.pid) ? result.pid : null,
    terminalId: String(result.terminalId || ''),
    sessionKey: String(result.sessionKey || sessionKey || ''),
    launchMode: String(result.launchMode || ''),
    executable: String(result.executable || ''),
    pids: Array.isArray(result.pids) ? result.pids : [],
    ...(egressWarning ? { egressWarning } : {})
  });
  return true;
}

// GET /v0/webui/app-entries - 按宿主机真实检测结果返回各 Provider 的桌面/CLI 入口可用性，
// 并附带当前桌面运行中的账号清单。
//
// 入口探测（PATH / 安装落点 / .app bundle）已由 Go 承接：Node 只保留两件本地事实——
// 静态能力声明（crossProviderHarness、外部 harness）与正在运行的桌面/CLI 实例。
// Go 不可用时整体回落本地探测器，账号页入口按钮不会因为核心重启而消失。
async function handleListAppEntriesRequest(ctx) {
  const refreshRequested = Boolean(ctx.url && typeof ctx.url.searchParams?.get === 'function'
    && ctx.url.searchParams.get('refresh') === '1');
  const detector = getAppEntryDetector(ctx);
  const capabilities = typeof detector.detectCapabilities === 'function'
    ? detector.detectCapabilities()
    : {};
  const running = collectRunningAppEntries(ctx, detector);
  const processObj = ctx.processObj || ctx.deps && ctx.deps.processObj || process;
  const env = ctx.env || ctx.deps && ctx.deps.env || processObj.env || {};
  // A headless Server cannot open a Desktop window for the browser. A Server
  // running inside a real GUI session may still expose native Desktop apps.
  const serverRuntime = !isDesktopHost({ platform: processObj.platform, env });

  const goEntries = await readGoAppEntries(ctx, refreshRequested);
  if (goEntries) {
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      // Go 的 Provider 合同不含外部 harness（pi / dsh / dsh-tui），这几条从本地探测器补齐；
      // 缺了它们，CLI 选择器会把已安装的 harness 一律标成「未安装」。
      entries: fillMissingHarnessEntries(goEntries.entries, capabilities, detector),
      capabilities,
      serverRuntime,
      ...running,
      probedAtMs: Number(goEntries.probedAtMs) || 0,
      expiresAtMs: Number(goEntries.expiresAtMs) || 0,
      cached: goEntries.cached === true,
      budgetExceededProviders: Array.isArray(goEntries.budgetExceededProviders)
        ? goEntries.budgetExceededProviders
        : [],
      unfilledFields: Array.isArray(goEntries.unfilledFields) ? goEntries.unfilledFields : []
    });
    return true;
  }

  if (refreshRequested && typeof detector.invalidate === 'function') detector.invalidate();
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    entries: detector.detect(),
    capabilities,
    serverRuntime,
    ...running
  });
  return true;
}

/** 读 Go 的入口探测结果；宿主缺失、调用失败或形状不对都返回 null，由调用方回落本地探测。 */
async function readGoAppEntries(ctx, refreshRequested) {
  const { available, response } = await callGoHost(ctx, 'getAppEntries', [refreshRequested]);
  if (!available || !response || response.ok !== true) return null;
  const data = response.data;
  if (!data || typeof data !== 'object') return null;
  if (!data.entries || typeof data.entries !== 'object') return null;
  return data;
}

/**
 * Go 只覆盖 Provider 合同内的条目；能力声明里有、Go 没返回的 id（外部 harness）
 * 用本地探测器补齐，避免「已安装」被误判成未安装。
 */
function fillMissingHarnessEntries(goEntries, capabilities, detector) {
  const entries = { ...goEntries };
  const missing = Object.keys(capabilities || {}).filter((id) => !entries[id]);
  if (!missing.length || typeof detector.detect !== 'function') return entries;
  let localEntries = {};
  try {
    localEntries = detector.detect() || {};
  } catch (_error) {
    return entries;
  }
  for (const id of missing) {
    if (localEntries[id]) entries[id] = localEntries[id];
  }
  return entries;
}

/** 汇总「当前正在运行的桌面/CLI 账号」，扫描失败按空清单降级。 */
function collectRunningAppEntries(ctx, detector) {
  let runningAccounts = [];
  let runningAccountPids = {};
  let runningCliAccounts = [];
  let runningCliAccountPids = {};
  try {
    const instances = typeof detector.scanRunning === 'function' ? detector.scanRunning() : [];
    runningAccountPids = matchRunningDesktopAccountPids(ctx, instances);
    runningAccounts = Object.keys(runningAccountPids);
  } catch (_error) {
    runningAccounts = [];
    runningAccountPids = {};
  }
  try {
    const instances = typeof detector.scanRunningCli === 'function' ? detector.scanRunningCli() : [];
    runningCliAccountPids = matchRunningCliAccountPids(ctx, instances);
    runningCliAccounts = Object.keys(runningCliAccountPids);
  } catch (_error) {
    runningCliAccounts = [];
    runningCliAccountPids = {};
  }
  return { runningAccounts, runningAccountPids, runningCliAccounts, runningCliAccountPids };
}

// 账号停用 / 清除默认 / 删除后回收宿主 Codex 的直连授权（详见
// lib/account/codex-host-grant-revoke.js）。只在账号确实握有授权时改写宿主文件；
// 网关档账号零写入。
function revokeCodexHostGrantForAccount(ctx, accountRef, options = {}) {
  const deps = ctx.deps || {};
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) return { ok: false, revoked: false, reason: 'ai_home_dir_unavailable' };
  const record = options.credentialRecord
    || readAccountCredentialRecord(ctx.fs, aiHomeDir, accountRef);
  return revokeCodexHostGrant({
    fs: ctx.fs,
    path,
    aiHomeDir,
    hostHomeDir: String(deps.hostHomeDir || '').trim(),
    accountRef,
    accountBaseUrl: record && record.env ? record.env.OPENAI_BASE_URL : '',
    syncGlobalConfigToHost: deps.syncGlobalConfigToHost
  });
}

// POST /v0/webui/accounts/:provider/:accountRef/status
//
// Go 的 webuiaccountstatusapi 是这条路径的唯一权威：accounts.enabled、Node 的
// account_state 展示投影、codex 宿主直连授权回收都在 Go 内完成。Node 只保留
// 协议外壳——解析路径与状态词、把 Node ref 翻译成 Go ref（goHost 内完成）、
// 代理请求，成功后刷新本进程运行池/桌面 runtime 并发布生命周期事件。
//
// 不再有纯 Node 回退：同一账号不再存在「Go 可用写 enabled、Go 不可用只写
// account_state」两套语义。Go 不可用时明确 503，由调用方重试。
async function handleUpdateAccountStatusRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/status$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const nextStatus = String(payload && payload.status || '').trim().toLowerCase();
  if (nextStatus !== 'up' && nextStatus !== 'down') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_status' });
    return true;
  }

  const { provider, accountRef } = parsed;
  return proxyGo(ctx, {
    method: 'setAccountStatus',
    args: [provider, accountRef, nextStatus],
    message: 'Go Core 未就绪，账号启停失败',
    // 400/404/409/500/502 都是 Go 的领域结论（非法状态 / 账号不存在 / Provider
    // 不匹配 / 投影失败 / 真值写入失败），状态码与响应体原样透出；503 也透出，
    // 只有「连接都没建立」（status 0）才回落成 go_core_unavailable。
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: (data) => {
      // 运行池是请求热路径读的内存投影：Go 已写完 account_state，这里立刻重载，
      // 否则开关看起来保存成功、路由仍按旧值选号。
      try {
        reloadRuntimeAccountsIfNeeded(ctx, provider);
      } catch (_error) {}
      // codex 宿主授权被真正回收后，桌面 runtime 仍持有旧配置，必须重载。
      const revoked = Boolean(data && data.hostGrantRevoke && data.hostGrantRevoke.revoked === true);
      if (revoked) {
        try { reloadDesktopRuntimeHook(ctx, provider); } catch (_error) {}
      }
      // 生命周期事件由 Node 进程内总线消费（运行池重建、活动清零、模型探测）。
      // 它不是写操作：配置事实已在 Go 提交，这里只把本地监听者叫醒。
      try {
        publishAccountLifecycleEvent(nextStatus === 'up' ? 'enabled' : 'disabled', {
          provider,
          accountRef,
          source: 'webui',
          after: { status: nextStatus, enabled: nextStatus !== 'down' }
        });
      } catch (_error) {}
      // accountRef 必须回调用方路径里的 Node 引用：同步 rekey 后 Go ref 与 Node ref
      // 不同，直接透传 Go ref 会让前端按错误的键合并账号行。
      const account = data && data.account && typeof data.account === 'object' ? data.account : {};
      return {
        ...data,
        account: {
          ...account,
          provider,
          accountRef,
          status: nextStatus,
          configured: account.configured !== false
        },
        provider,
        accountRef,
        status: nextStatus,
        enabled: nextStatus === 'up'
      };
    }
  });
}

// Go 尚未承接静态轮换的 Provider 仍走合同派生的通用 env 补丁。
function credentialPatchText(value) {
  return String(value == null ? '' : value).trim();
}

function getGenericCredentialPatch(providerRaw) {
  const facts = getProviderCredentialFacts(credentialPatchText(providerRaw).toLowerCase()) || {};
  const apiKeyEnvKeys = Array.isArray(facts.apiKeyEnv) ? facts.apiKeyEnv.filter(Boolean) : [];
  const baseUrlEnvKey = Array.isArray(facts.baseUrlEnv) ? (facts.baseUrlEnv.filter(Boolean)[0] || '') : '';
  if (apiKeyEnvKeys.length === 0 && !baseUrlEnvKey) return null;
  return { apiKeyEnvKeys, baseUrlEnvKey };
}

function resolveCredentialBaseUrl(providerRaw, credentialEnv, { baseUrl, payload } = {}) {
  if (payload && 'baseUrl' in payload) return baseUrl;
  const patch = getGenericCredentialPatch(providerRaw);
  if (!patch || !patch.baseUrlEnvKey) return '';
  return credentialPatchText((credentialEnv || {})[patch.baseUrlEnvKey]);
}

function applyCredentialPatch(providerRaw, { env, apiKey, baseUrl, payload }) {
  const patch = getGenericCredentialPatch(providerRaw);
  if (!patch) return { ok: true, credentialType: '' };
  if (apiKey && patch.apiKeyEnvKeys.length > 0) {
    patch.apiKeyEnvKeys.forEach((key) => { env[key] = apiKey; });
  }
  if (payload && 'baseUrl' in payload && patch.baseUrlEnvKey) {
    if (baseUrl) env[patch.baseUrlEnvKey] = baseUrl;
    else delete env[patch.baseUrlEnvKey];
  }
  return { ok: true, credentialType: '' };
}

const GO_STATIC_ACCOUNT_PROVIDERS = new Set(['codex', 'claude', 'gemini']);

// Go 已接受一次静态凭据编辑后，把同一组值写回 Node 的只读投影。
// 这里只服务账号页展示，不再做身份/校验决策。
function applyGoStaticCredentialProjection(provider, target, input) {
  const apiKey = String(input.apiKey || '').trim();
  const includeBaseUrl = input.includeBaseUrl === true;
  const baseUrl = String(input.baseUrl || '').trim();
  if (provider === 'codex') {
    const key = apiKey || String(target.OPENAI_API_KEY || '').trim();
    target.OPENAI_API_KEY = key;
    if (includeBaseUrl) {
      if (baseUrl) target.OPENAI_BASE_URL = baseUrl;
      else delete target.OPENAI_BASE_URL;
    }
    return '';
  }
  if (provider === 'gemini') {
    if (apiKey) {
      target.GEMINI_API_KEY = apiKey;
      target.GOOGLE_API_KEY = apiKey;
    }
    if (includeBaseUrl) {
      if (baseUrl) target.GEMINI_BASE_URL = baseUrl;
      else delete target.GEMINI_BASE_URL;
    }
    return '';
  }
  const currentType = getClaudeCredentialType({ env: target }) || CLAUDE_CREDENTIAL_TYPES.API_KEY;
  const nextType = getClaudeCredentialType({ credentialType: input.credentialType }) || currentType;
  const key = apiKey || String(
    nextType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
      ? target.ANTHROPIC_AUTH_TOKEN
      : target.ANTHROPIC_API_KEY
  ).trim();
  const next = writeClaudeCredentialEnv(target, {
    credentialType: nextType,
    token: key,
    ...(includeBaseUrl ? { baseUrl } : {})
  });
  Object.keys(target).forEach((name) => { delete target[name]; });
  Object.assign(target, next);
  return nextType;
}

async function handleUpdateAccountRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    accountStateService,
    readRequestBody,
    loadServerRuntimeAccounts,
    applyReloadState,
    state,
    fs,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/update$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (!detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'update_account_unsupported',
      code: 'oauth_config_edit_unsupported',
      message: 'OAuth 账号不支持编辑 API Key 配置，请使用重新登录。'
    });
    return true;
  }

  const apiKey = String(payload && payload.apiKey || '').trim();
  const baseUrl = String(payload && payload.baseUrl || '').trim();
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
    return;
  }
  // 调度规则是「第三方/自建上游」专属：带规则的提交在官方地址账号上一律拒绝（清空规则
  // 是空数组，不算带规则），避免一次保存就把官方账号留在一套注定不命中的规则上。
  if (hasUpstreamErrorRulesPayload(payload)) {
    const rejection = resolveRoutingRulesUpstreamRejection(ctx, provider, accountRef,
      Object.prototype.hasOwnProperty.call(payload, 'baseUrl') ? { baseUrl } : {});
    if (rejection) {
      writeJson(ctx.res, 400, rejection);
      return true;
    }
  }
  let errorRules;
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'upstreamErrorRules')) {
    try { errorRules = validateUpstreamErrorRules(payload.upstreamErrorRules); }
    catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code, message: error.message });
      return true;
    }
  }
  let errorGroupIds;
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'upstreamErrorGroupIds')) {
    errorGroupIds = readUpstreamErrorGroupIds({
      [ERROR_RULE_GROUP_IDS_ENV_KEY]: JSON.stringify(payload.upstreamErrorGroupIds)
    });
    const available = new Set(readUpstreamErrorMappingGroups(fs, aiHomeDir).groups.map((group) => group.id));
    if (errorGroupIds.some((id) => !available.has(id))) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_upstream_error_group', message: '存在未找到的异常映射组。' });
      return true;
    }
  }
  const requestedCredentialType = payload && (payload.credentialType || payload.authType || payload.authMode);

  // Validate URL if provided
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch (_error) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_base_url' });
      return true;
    }
  }
  if (isSelfRelayBaseUrl(provider, baseUrl, ctx)) {
    writeSelfRelayAccountRejected(ctx, provider);
    return true;
  }

  const credentialEnv = readAccountCredentials(fs, aiHomeDir, accountRef) || {};
  const effectiveBaseUrl = resolveCredentialBaseUrl(provider, credentialEnv, { baseUrl, payload });
  if (isSelfRelayBaseUrl(provider, effectiveBaseUrl, ctx)) {
    writeSelfRelayAccountRejected(ctx, provider);
    return true;
  }

  const accountArtifactHooks = ctx.deps && ctx.deps.accountArtifactHooks;
  const authSnapshotBefore = accountArtifactHooks
    && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountRef)
    : null;
  let updatedClaudeCredentialType = '';
  const nextCredentialEnv = { ...credentialEnv };

  // codex/claude 的静态凭据写入口已切到 Go：空密钥/未带地址的语义、身份校验、
  // CAS 和落库都在 Go；Node 只转发编辑意图并维护读投影。
  if (GO_STATIC_ACCOUNT_PROVIDERS.has(provider)) {
    const goHost = ctx.deps && ctx.deps.goCoreSync;
    if (!goHost
      || typeof goHost.editStaticCredential !== 'function'
      || typeof goHost.isEnabled !== 'function'
      || !goHost.isEnabled()) {
      writeJson(ctx.res, 503, {
        ok: false,
        error: 'go_core_required',
        message: '账号凭据编辑已切换到 Go Core，当前 Go Core 不可用。'
      });
      return true;
    }
    const includeBaseUrl = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'baseUrl'));
    const rotation = await goHost.editStaticCredential(accountRef, {
      api_key: apiKey,
      base_url: baseUrl,
      include_base_url: includeBaseUrl,
      auth_kind: requestedCredentialType || ''
    });
    if (!rotation || rotation.ok !== true) {
      const status = rotation && [400, 404, 409, 422].includes(rotation.status) ? rotation.status : 502;
      writeJson(ctx.res, status, {
        ok: false,
        error: rotation && rotation.errorCode || 'go_credential_edit_failed',
        message: 'Go Core 凭据编辑失败，账号未被修改。'
      });
      return true;
    }
    updatedClaudeCredentialType = applyGoStaticCredentialProjection(provider, nextCredentialEnv, {
      apiKey,
      baseUrl,
      includeBaseUrl,
      credentialType: requestedCredentialType
    });
  } else {
    // 其余 Provider 仍由 Node 补丁注册表处理，直到 Go 补齐对应 codec。
    const credentialPatch = applyCredentialPatch(provider, {
      env: nextCredentialEnv,
      apiKey,
      baseUrl,
      payload,
      credentialType: requestedCredentialType
    });
    if (credentialPatch.ok === false) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: credentialPatch.error,
        ...(credentialPatch.message ? { message: credentialPatch.message } : {})
      });
      return true;
    }
    updatedClaudeCredentialType = credentialPatch.credentialType || '';
  }

  // 规则是调度元数据，修改它不能制造“新凭据已修复认证”的证据。
  const credentialChanged = Object.keys({ ...credentialEnv, ...nextCredentialEnv })
    .some(key => key !== ERROR_RULES_ENV_KEY && key !== ERROR_RULE_GROUP_IDS_ENV_KEY && credentialEnv[key] !== nextCredentialEnv[key]);
  if (errorRules) {
    if (errorRules.length) nextCredentialEnv[ERROR_RULES_ENV_KEY] = JSON.stringify(errorRules);
    else delete nextCredentialEnv[ERROR_RULES_ENV_KEY];
  }
  if (errorGroupIds) {
    if (errorGroupIds.length) nextCredentialEnv[ERROR_RULE_GROUP_IDS_ENV_KEY] = JSON.stringify(errorGroupIds);
    else delete nextCredentialEnv[ERROR_RULE_GROUP_IDS_ENV_KEY];
  }
  // Go 已接受（或非 Go 管理 Provider 的本地补丁）；这里只维护 Node 的读投影。
  writeAccountCredentials(fs, aiHomeDir, accountRef, nextCredentialEnv, { preserveCredentialTimestamp: !credentialChanged });
  if (payload && payload.clearErrorBlock === true) {
    clearAccountRoutingBlock(ctx, provider, accountRef, accountStateService);
  }
  if (credentialChanged && authSnapshotBefore && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountRef,
      before: authSnapshotBefore,
      source: 'webui_account_updated',
      reason: 'credentials_updated'
    });
  }

  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  if (credentialChanged) invalidateModelCacheForAccountRefs(ctx, [accountRef]);
  if (updatedClaudeCredentialType && account) {
    account.apiKeyMode = true;
    account.authMode = updatedClaudeCredentialType;
    account.authType = updatedClaudeCredentialType;
    account.credentialType = updatedClaudeCredentialType;
    account.baseUrl = effectiveBaseUrl;
    if (!account.displayName || account.displayName === accountRef) {
      account.displayName = getApiKeyDisplayName(provider, { baseUrl: effectiveBaseUrl });
    }
  }

  if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
    const nextStateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState(accountRef)
      : null;
    const nextState = buildPersistedAccountState(ctx, provider, accountRef, nextStateRow, {
      configured: account && account.configured,
      apiKeyMode: account && account.apiKeyMode,
      authMode: account && account.authMode,
      displayName: account && account.displayName,
      baseUrl: account && account.baseUrl,
      remainingPct: account && account.remainingPct,
      status: account && account.status
    });
    accountStateService.syncAccountBaseState(accountRef, provider, nextState);
  }

  writeJson(ctx.res, 200, { ok: true, account });
  return true;
}
// 账号级「清除异常阻塞」（routing_block）：统一走运行态门禁（见 account-runtime-gate 的
// observeRecovery，evidence=manual_admin_clear + scope=routing_block）；未装配门禁时退回直调服务。
function clearAccountRoutingBlock(ctx, provider, accountRef, accountStateService) {
  const gate = ctx && ctx.deps && ctx.deps.accountRuntimeGate;
  if (gate && typeof gate.observeRecovery === 'function') {
    return gate.observeRecovery({
      account: { accountRef, provider },
      provider,
      evidence: 'manual_admin_clear',
      scope: 'routing_block',
      clear: 'routing_block',
      reloadPool: true,
      source: 'webui.account.clear_error_block'
    });
  }
  if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
  return Boolean(accountStateService.clearRuntimeBlock(accountRef, provider, {
    evidence: 'manual_admin_clear',
    scope: 'routing_block'
  }));
}



async function handleUpdateAccountRoutingRulesRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/routing-rules$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_routing_rules' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'updateAccountRoutingRules',
    args: [provider, accountRef, payload],
    message: 'Go Core 未就绪，调度规则未保存',
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: async (data) => {
      try { reloadRuntimeAccountsIfNeeded(ctx, provider); } catch (_error) {}
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
        skipUsageRefresh: true,
        skipRuntimeReload: true
      });
      return { ...data, account };
    }
  });
}

async function handleSetDefaultAccountRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  return proxyGo(ctx, {
    method: 'setWebUIDefault',
    args: [provider, accountRef],
    message: 'Go Core 未就绪，默认账号未修改',
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: async (data) => {
      const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
        skipUsageRefresh: true,
        skipRuntimeReload: true
      });
      return { ...data, account, ...(desktopRuntime ? { desktopRuntime } : {}) };
    }
  });
}

async function handleClearDefaultAccountRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  return proxyGo(ctx, {
    method: 'clearWebUIDefault',
    args: [provider, accountRef],
    message: 'Go Core 未就绪，默认账号未清除',
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: async (data) => {
      const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
        skipUsageRefresh: true,
        skipRuntimeReload: true
      });
      return { ...data, account, ...(desktopRuntime ? { desktopRuntime } : {}) };
    }
  });
}

async function handleSetMobileAccountRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  return proxyGo(ctx, {
    method: 'setWebUIMobile',
    args: [provider, accountRef],
    message: 'Go Core 未就绪，Codex App 账号未绑定',
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: async (data) => {
      const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
        skipUsageRefresh: true,
        skipRuntimeReload: true
      });
      return { ...data, account, hotSyncQueued: false, desktopRuntime };
    }
  });
}

async function handleClearMobileAccountRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  return proxyGo(ctx, {
    method: 'clearWebUIMobile',
    args: [provider, accountRef],
    message: 'Go Core 未就绪，Codex App 账号未解绑',
    passStatuses: [400, 404, 409, 500, 502, 503],
    transform: async (data) => {
      const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
        skipUsageRefresh: true,
        skipRuntimeReload: true
      });
      return { ...data, account, hotSyncQueued: false, desktopRuntime };
    }
  });
}

async function handleDeleteAccountRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  // Go 独有账号：Node 账号库没有、Go 有。存在性判定仍然按 Node 的账号库走，
  // 因为「Node 没有这一行」正是这条路径要处理的形态。
  const goOnlyDelete = !accountExists(ctx, provider, accountRef);
  if (goOnlyDelete && !goOnlyAccountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const forceRequested = isForceDeleteRequest(ctx);
  const goDeletionMode = resolveGoDeletionMode(provider, ctx.deps && ctx.deps.goCoreSync, {
    goOnly: goOnlyDelete
  });
  if (goDeletionMode === 'required_unavailable') {
    // 账号删除已整体切到 Go：没有本地回退，否则同一账号会出现两套删除语义。
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_required',
      message: '账号删除已切换到 Go Core，当前 Go Core 不可用。'
    });
    return true;
  }
  if (goDeletionMode === 'go') {
    return handleGoDeleteAccountRequest(ctx, { provider, accountRef, forceRequested });
  }
  return handleNodeDeleteAccountRequest(ctx, { provider, accountRef, forceRequested });
}

// handleGoDeleteAccountRequest 是 Go 删除路径的协议外壳。
async function handleGoDeleteAccountRequest(ctx, { provider, accountRef, forceRequested }) {
  const { writeJson } = ctx;
  // agy 暖机 LS 池是 aih 自己的可丢弃缓存（不是用户的工作）：删号时必须由删除流程
  // 自己回收，驱逐不掉就 fail-closed，否则会留下一个攥着已删凭据的常驻进程。
  try {
    await evictAgyWarmWriterBeforeDelete(ctx, provider, accountRef);
  } catch (error) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: String((error && error.message) || error || 'agy_warm_writer')
    });
    return true;
  }
  // Node 进程内的占用者：先如实列出谁在占用，用户确认后带 force 重来。
  const occupancy = await detectDeletionBlockers(ctx, {
    provider,
    accountRef,
    aiHomeDir: resolveAiHomeDir(ctx)
  });
  if (occupancy.blocked) {
    if (!forceRequested) {
      writeJson(ctx.res, 409, {
        ok: false,
        error: 'account_runtime_active',
        message: buildOccupancyMessage(occupancy.items),
        occupants: occupancy.items
      });
      return true;
    }
    const release = await releaseDeletionBlockers(ctx, occupancy.items);
    if (!release.released) {
      writeJson(ctx.res, 409, {
        ok: false,
        error: 'account_runtime_active',
        message: buildReleaseFailureMessage(release.failed),
        occupants: release.failed
      });
      return true;
    }
  }
  // 交棒给 Go：占用者与宿主运行时、宿主投影、持久化删除都在那边判定与执行。
  // 状态码与响应体原样透出：409 的 occupants 与 503 的原因码都是 Go 的领域结论。
  return proxyGo(ctx, {
    method: 'deleteAccount',
    args: [accountRef, { force: forceRequested }],
    message: 'Go Core 未就绪，账号无法删除',
    // Go 的删除失败都是领域结论（400/404/409/502/503），带 body 原样透出；
    // 只有「连接都没建立」（status 0）才回落成 503 go_core_unavailable。
    passStatuses: [400, 404, 409, 502, 503],
    transform: (data) => {
      forgetNodeAccountProjection(ctx, provider, accountRef);
      return data;
    }
  });
}

// forgetNodeAccountProjection 在 Go 提交删除之后拆掉 Node 自己那份账号投影。
//
// 这不是删除编排：账号事实已经在 Go 落库删除，这里只把 Node 私有存储（app-state.db
// 的 account_refs / 墓碑 / 各种账号级 app_kv、Node 内存行、codex app-server）里
// 指向它的记录撤掉。Go 已跑过会话写者校验、资源对账与投影回收，所以传
// hostCleanupHandledByGo=true 跳过那些重复实现。
function forgetNodeAccountProjection(ctx, provider, accountRef) {
  try {
    removeLiveAccountRecord(ctx, provider, accountRef, 'manual_delete');
  } catch (_error) { /* 内存投影清不掉不影响删除事实 */ }
  try {
    const aiHomeDir = resolveAiHomeDir(ctx);
    if (!aiHomeDir) return;
    const removal = createAccountRemovalService({
      fs: ctx.fs,
      aiHomeDir,
      path,
      processObj: ctx.deps && ctx.deps.processObj,
      hostHomeDir: ctx.deps && ctx.deps.hostHomeDir,
      ensureSessionStoreLinks: ctx.ensureSessionStoreLinks
        || (ctx.deps && ctx.deps.ensureSessionStoreLinks),
      hostCleanupHandledByGo: true,
      accountStateService: ctx.accountStateService
    });
    // Go 独有账号在 Node 没有行，本地清理报「没删到」是预期结果。
    removal.deleteAccountByRef(provider, accountRef);
  } catch (_error) { /* 删除事实已提交，投影残留只影响本进程展示 */ }
}

// handleNodeDeleteAccountRequest 是仍留在 Node 的 Provider（当前只有 zcode）的处理。
async function handleNodeDeleteAccountRequest(ctx, { provider, accountRef, forceRequested }) {
  const {
    fs,
    deps,
    accountStateService,
    writeJson
  } = ctx;
  const occupancyTarget = {
    provider,
    accountRef,
    aiHomeDir: resolveAiHomeDir(ctx)
  };
  try {
    const occupancy = await detectDeletionBlockers(ctx, occupancyTarget);
    if (occupancy.blocked) {
      if (!forceRequested) {
        writeJson(ctx.res, 409, {
          ok: false,
          error: 'account_runtime_active',
          message: buildOccupancyMessage(occupancy.items),
          occupants: occupancy.items
        });
        return true;
      }
      const release = await releaseDeletionBlockers(ctx, occupancy.items);
      if (!release.released) {
        writeJson(ctx.res, 409, {
          ok: false,
          error: 'account_runtime_active',
          message: buildReleaseFailureMessage(release.failed),
          occupants: release.failed
        });
        return true;
      }
    }
    const aiHomeDir = occupancyTarget.aiHomeDir;
    // agy 暖机 LS 池是 aih 自己的可丢弃缓存（不是用户的工作），删号时必须由删除
    // 流程自己回收：驱逐不掉就 fail-closed，否则会留下一个攥着已删凭据的常驻进程。
    await evictAgyWarmWriterBeforeDelete(ctx, provider, accountRef);
    // 删除前先判断它是不是当前默认账号：删掉之后就没有默认账号了，落点要回到
    // AIH Server（与 CLI `set-default` 不带账号号同义）。
    const wasDefaultAccount = readDefaultAccountRef(fs, aiHomeDir, provider) === accountRef;
    // 删除前先回收宿主直连授权（此时账号凭证记录还在，能按上游地址判定）。
    const hostGrantRevoke = revokeHostGrantHook(ctx, provider, accountRef);
    const accountRemovalService = createAccountRemovalService({
      fs,
      aiHomeDir,
      path,
      processObj: deps && deps.processObj,
      hostHomeDir: deps && deps.hostHomeDir,
      ensureSessionStoreLinks: ctx.ensureSessionStoreLinks
        || (deps && deps.ensureSessionStoreLinks),
      accountStateService
    });
    const removal = accountRemovalService.deleteAccountByRef(provider, accountRef);
    if (!removal.deleted) {
      throw new Error('account_ref_delete_failed');
    }
    try {
      reloadRuntimeAccountsIfNeeded(ctx, provider);
    } catch (_error) {}
    removeLiveAccountRecord(ctx, provider, accountRef, 'manual_delete');
    // 收回授权的那条链已经落过档位（宿主同步 + 档位写入），不重复同步；只有
    // 「默认账号被删但没有残留授权可收回」或那条链写档位失败时才补一次落点。
    const landedByRevoke = Boolean(
      hostGrantRevoke && hostGrantRevoke.revoked && hostGrantRevoke.defaultProfileUpdated !== false
    );
    const aihServerDefault = (!landedByRevoke && wasDefaultAccount)
      ? landOnAihServerDefault({
        fs,
        aiHomeDir,
        provider,
        syncGlobalConfigToHost: deps && deps.syncGlobalConfigToHost
      })
      : { ok: true, landed: false, reason: landedByRevoke ? 'landed_with_host_grant_revoke' : 'no_default_change' };
    writeJson(ctx.res, 200, { ok: true, aihServerDefault, ...(hostGrantRevoke ? { hostGrantRevoke } : {}) });
    return true;
  } catch (error) {
    const runtimeActive = error && error.code === 'account_runtime_active';
    writeJson(ctx.res, runtimeActive ? 409 : 500, {
      ok: false,
      error: runtimeActive ? 'account_runtime_active' : 'delete_account_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}


function readExportListParam(url, name) {
  if (!url || !url.searchParams) return [];
  return url.searchParams.getAll(name)
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildGoExportFileName({ accountRefs, providers, accounts }) {
  const day = new Date().toISOString().slice(0, 10);
  if (accountRefs.length === 1 && accounts.length === 1) {
    return `aih-account-${accounts[0].provider}-${accounts[0].accountRef}-${day}.json`;
  }
  if (providers.length === 1) return `aih-accounts-${providers[0]}-${day}.json`;
  return `aih-accounts-${day}.json`;
}

async function handleExportAccountsRequest(ctx) {
  const { fs, aiHomeDir, deps, url, writeJson, res } = ctx;
  try {
    const format = String(url && url.searchParams && url.searchParams.get('format') || '').trim().toLowerCase();
    if (format && format !== 'aih' && format !== 'native') {
      writeJson(res, 400, { ok: false, error: 'unsupported_export_format' });
      return true;
    }
    const providers = readExportListParam(url, 'provider');
    const accountRefs = readExportListParam(url, 'accountRef');
    const goHost = deps && deps.goCoreSync;
    if (!goHost
      || typeof goHost.exportAccounts !== 'function'
      || typeof goHost.isEnabled !== 'function'
      || !goHost.isEnabled()) {
      writeJson(res, 503, { ok: false, error: 'go_core_required' });
      return true;
    }
    const exported = await goHost.exportAccounts({ providers, accountRefs });
    if (!exported || !exported.ok || !exported.document || !Array.isArray(exported.document.accounts)) {
      writeJson(res, exported && exported.status === 404 ? 404 : 502, {
        ok: false,
        error: exported && exported.errorCode || 'go_export_failed'
      });
      return true;
    }
    const document = exported.document;
    if (accountRefs.length > 0 && document.accounts.length === 0) {
      writeJson(res, 404, { ok: false, error: 'account_not_found' });
      return true;
    }
    // Go 尚未接管的 Node-only 账号（当前只有 gemini Vertex 占位）不静默消失：
    // 用响应头明确计数。按 provider 计数而不是 accountRef 比较——两端的 native ref
    // 可能不同（zcode），按 ref 比会把同一账号误报成 Node-only。
    const exportedCounts = document.accounts.reduce((counts, entry) => {
      const provider = String(entry.provider || '');
      counts[provider] = (counts[provider] || 0) + 1;
      return counts;
    }, {});
    let nodeOnly = 0;
    for (const provider of SUPPORTED_SERVER_PROVIDERS) {
      if (providers.length > 0 && !providers.includes(provider)) continue;
      const nodeCount = listAccountCredentialRecords(fs, aiHomeDir, provider)
        .filter((record) => accountRefs.length === 0 || accountRefs.includes(record.accountRef))
        .length;
      nodeOnly += Math.max(0, nodeCount - (exportedCounts[provider] || 0));
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${buildGoExportFileName({ accountRefs, providers, accounts: document.accounts })}"`,
      'Cache-Control': 'no-store',
      'X-AIH-Exported-Accounts': String(document.accounts.length),
      'X-AIH-Skipped-Accounts': '0',
      'X-AIH-Node-Only-Accounts': String(nodeOnly)
    });
    res.end(`${JSON.stringify(document, null, 2)}\n`);
    return true;
  } catch (_error) {
    writeJson(res, 500, { ok: false, error: 'export_failed' });
    return true;
  }
}

async function handleGetImportJobRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/import\/jobs\/([^/]+)$/);
  const job = matches ? accountImportJobs.get(matches[1]) : null;
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, job: serializeAccountImportJob(job) });
  return true;
}

async function handleImportAccountsRequest(ctx) {
  const {
    readRequestBody,
    writeJson
  } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: WEBUI_ACCOUNT_IMPORT_MAX_BYTES })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_import_data' });
    return true;
  }
  const activeJob = findActiveAccountImportJob();
  if (activeJob) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'import_job_already_running',
      jobId: activeJob.id,
      job: serializeAccountImportJob(activeJob)
    });
    return true;
  }
  const job = startAccountImportJob(ctx, payload);
  writeJson(ctx.res, 202, buildImportJobResponse(job));
  return true;
}

module.exports = {
  handleListAccountsRequest,
  handleDetectHostAccountsRequest,
  handleGetImportJobRequest,
  handleGetAddJobRequest,
  handleCancelAddJobRequest,
  handleConfirmAddJobInstallRequest,
  handleCompleteAddJobCallbackRequest,
  handleZcodeUrlCallbackRequest,
  handleLocalAuthImportRequest,
  handleProviderAuthSourcesRequest,
  handleLocalAuthSourceImportRequest,
  handlePluginAccountLoginStartRequest,
  handlePluginAccountLoginPollRequest,
  handlePluginAccountLoginSubmitRequest,
  handlePluginAccountLoginCancelRequest,
  handleAddAccountRequest,
  handleRefreshAccountUsageRequest,
  handleKimiDesktopSessionStartRequest,
  handleKimiDesktopSessionPollRequest,
  handleKimiDesktopSessionWatchRequest,
  handleKimiPlanStatsRequest,
  createWebUiAccountAppLauncher,
  resolveAccountAppErrorMessage,
  resolveAccountAppErrorStatus,
  handleOpenAccountAppRequest,
  handleListAppEntriesRequest,
  handleUpdateAccountStatusRequest,
  handleUpdateAccountRequest,
  handleUpdateAccountRoutingRulesRequest,
  handleSetDefaultAccountRequest,
  handleClearDefaultAccountRequest,
  handleSetMobileAccountRequest,
  handleClearMobileAccountRequest,
  handleReauthAccountRequest,
  handleDeleteAccountRequest,
  resolveGoDeletionMode,
  GO_DELETION_PROVIDERS,
  handleExportAccountsRequest,
  handleImportAccountsRequest,
  inferReauthAuthMode
};
