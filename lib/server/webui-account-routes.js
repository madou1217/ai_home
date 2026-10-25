'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
  readAccountCredentialRecord,
  readAccountCredentials,
  writeAccountCredentials
} = require('./account-credential-store');
const { detectHostAccounts } = require('../account/host-account-detectors');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { resolveEffectiveAccountStatus } = require('../account/status-file');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { ensureDirSync } = require('./fs-compat');
const {
  configureApiKeyAccount,
  configureVertexAiAccount,
  getDefaultAuthMode,
  isSupportedAuthMode,
  normalizeAuthMode,
  normalizeExistingAccountRef,
  serializeAuthJob,
  isSupportedAuthStrategy
} = require('./web-account-auth');
const { applyCredentialPatch, resolveCredentialBaseUrl } = require('./account-credential-patch');
const {
  buildAntigravityManagerExportPayload,
  buildSub2ApiExportPayload,
  importStandardAccountRecords
} = require('../account/standard-transfer');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const {
  ACCOUNT_EGRESS_BINDING_UNAVAILABLE,
  ACCOUNT_EGRESS_UNAVAILABLE,
  ZCODE_EGRESS_BINDING_UNAVAILABLE,
  ZCODE_EGRESS_UNAVAILABLE,
  launchAccountAppWithEgress,
  pickZcodeEgressDependencies
} = require('./zcode-egress-service');
const {
  extractImportRecords,
  buildRuntimeImportTools
} = require('./web-account-transfer');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsLiveEvent
} = require('./webui-account-live');
const { withAccountQueryListFns } = require('./account-load-args');
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName
} = require('./account-display-identity');
const { createCodexDesktopHookService } = require('./codex-desktop-hook');
const { validateCodexDesktopAccount } = require('./codex-desktop-account');
const { reloadCodexDesktopRuntime } = require('./codex-desktop-runtime-reload');
const { isLoopbackUrl } = require('./http-utils');
const { supportsAihServerProfile } = require('../account/self-relay-account');
const { createAccountRemovalService } = require('../account/account-removal');
const agyWarmPool = require('./agy-warm-ls-pool');
const {
  clearDefaultAccountRef,
  clearDefaultProviderProfile,
  readDefaultAccountRef,
  writeDefaultAccountRef
} = require('../account/default-account-store');
const { landOnAihServerDefault } = require('../account/host-default-landing');
const {
  resolveAccountRef,
  listAccountRefRecords
} = require('./account-ref-store');
const { deriveRuntimeStatus } = require('../account/runtime-view');
const { resolveClientPlatform, CLIENT_PLATFORMS } = require('../runtime/client-platform');
const { getAppInstallJobManager } = require('./webui-app-install-routes');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { evaluateDefaultAccountEligibility } = require('./account-default-eligibility');
const { revokeCodexHostGrant } = require('../account/codex-host-grant-revoke');
const {
  invalidateWebUiModelsCacheAccountRefs
} = require('./webui-model-cache');
const { getProviderCLIConfig, getProviderDefinition } = require('../provider-catalog');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { createWebUiAccountAppLauncher } = require('./webui-account-app-launcher');

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

const { invalidateModelCacheForAccountRefs, buildPendingOauthResponse, reloadRuntimeAccountsIfNeeded, parseAccountRoute, isSelfRelayBaseUrl, writeSelfRelayAccountRejected, resolveAiHomeDir, accountExists, inferReauthAuthMode, buildCallbackErrorMessage } = require('./webui-account-routes-utils');
const { applyAliasPoolPreference, readAliasPoolParticipates } = require('../account/alias-pool-preference');
const { detectStoredApiKeyMode, resolveAccountStatus, readStateBoolean, buildPersistedAccountState, readBooleanStateValue, isPendingOauthStateRow } = require('./webui-account-routes-state');
const {
  resolveCodexDesktopHookService,
  queueCodexDesktopAccountSync,
  setCodexDesktopAccount,
  clearCodexDesktopAccount,
  sharedAppEntryDetector,
  getAppEntryDetector,
  matchRunningDesktopAccounts,
  matchRunningDesktopAccountPids,
  matchRunningCliAccounts,
  matchRunningCliAccountPids
} = require('./webui-account-routes-desktop');
const { ACCOUNT_REFRESH_JOB_RETENTION_MS, ACCOUNT_REFRESH_JOB_MAX, accountRefreshJobs, enqueueAuthInvalidReconcileIfNeeded, findRuntimeAccount, pickAuthInvalidRuntimeStatus, pickBlockingStatusValue, makeAccountRefreshJobId, isAccountRefreshJobActive, pruneAccountRefreshJobs, findActiveAccountRefreshJob, serializeAccountRefreshJob, emitAccountRefreshJobEvent, startAccountRefreshJob } = require('./webui-account-routes-refresh');
const { WEBUI_ACCOUNT_IMPORT_MAX_BYTES, ACCOUNT_IMPORT_JOB_RETENTION_MS, ACCOUNT_IMPORT_JOB_MAX, ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS, accountImportJobs, createImportSummary, addImportedProvider, summarizeUnifiedImportResult, safeUploadRelativePath, decodeBase64UploadContent, normalizeUploadedFiles, writeUploadedFilesToTempDir, summarizeRecordImportResult, isImportJobActive, pruneAccountImportJobs, findActiveAccountImportJob, appendAccountImportJobLog, serializeAccountImportJob, emitAccountImportJobEvent, emitAccountImportJobProgressEvent, buildImportJobContext, buildImportJobResponse, createImportJobProgressUpdater, executeAccountImportPayload, startAccountImportJob, importStandardRecordsForWeb, importUploadedAccountFiles } = require('./webui-account-routes-import');
const { REMOVED_WEB_ANTIGRAVITY_PLUGIN_EXPORT_FORMATS, normalizeWebExportFormatToken, isRemovedWebExportFormat, normalizeWebExportFormat, webExportFileName, buildWebExportPayload } = require('./webui-account-routes-export');
const { evictAgyWarmWriterBeforeDelete, hasActiveNativeAccountRun, assertNoActiveNativeRunBeforeDelete } = require('./webui-account-routes-delete');
const {
  detectDeletionBlockers,
  releaseDeletionBlockers
} = require('./account-deletion-occupancy');
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
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/);
  const job = getAuthJobManager(deps, state).getJob(matches[1]);
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  if (job.status !== 'running' && job.status !== 'succeeded' && typeof cleanupAuthJobArtifacts === 'function') {
    cleanupAuthJobArtifacts(job, deps, state);
  }
  writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(job) });
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
    job: result.job ? serializeAuthJob(result.job) : null
  });
  return true;
}

// GET /v0/webui/accounts/provider-auth-sources?provider=<id>
// 认证来源链的解析结果：这台机器上「每个认证方式现在能用哪些来源、能不能装」。
// 界面据此渲染「从本机导入」与安装提示，不自己判断环境。
async function handleProviderAuthSourcesRequest(ctx) {
  const { url, writeJson } = ctx;
  const provider = String((url && url.searchParams && url.searchParams.get('provider')) || '').trim().toLowerCase();
  if (!provider) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_provider' });
    return true;
  }
  const { describeAuthMethodsWithSources } = require('../account/auth-sources');
  const { peekPluginSystem } = require('../plugins/control/plugin-system');
  const { describeAuthMethodsWithPluginSources } = require('../plugins/account/auth-sources');
  const aiHomeDir = resolveAiHomeDir(ctx);
  const pluginAccount = peekPluginSystem(ctx.state)?.account || null;
  const resolved = pluginAccount
    ? await describeAuthMethodsWithPluginSources(provider, pluginAccount, {
      fs: ctx.fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: ctx.deps && ctx.deps.hostHomeDir }
    })
    : describeAuthMethodsWithSources(provider, {
      // 传账号池：本机登录态已在账号池里的来源会被标成 account_already_registered（界面不显示）。
      fs: ctx.fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: ctx.deps && ctx.deps.hostHomeDir }
    });
  writeJson(ctx.res, 200, { ok: true, ...resolved });
  return true;
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
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  if (detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
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
    const started = getAuthJobManager(deps, state).startOauthJob(provider, authMode, { accountRef });
    writeJson(ctx.res, 200, buildPendingOauthResponse(started, authMode));
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

async function handleRefreshAccountUsageRequest(ctx) {
  const {
    pathname,
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
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    enqueueAuthInvalidReconcileIfNeeded(ctx, provider, accountRef, stateRow);
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'refresh_usage_unsupported',
      code: 'api_key_usage_refresh_unsupported',
      message: 'API Key 账号不支持额度刷新。'
    });
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

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  const routeDeps = ctx.deps || {};

  const launcher = createWebUiAccountAppLauncher(ctx, provider, accountRef, action);
  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: { provider, accountRef, kind, action, terminalId, workdir, harness, model },
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
    executable: String(result.executable || ''),
    pids: Array.isArray(result.pids) ? result.pids : [],
    ...(egressWarning ? { egressWarning } : {})
  });
  return true;
}

async function handleListAppEntriesRequest(ctx) {
  const detector = getAppEntryDetector(ctx);
  const refreshRequested = Boolean(ctx.url && typeof ctx.url.searchParams?.get === 'function'
    && ctx.url.searchParams.get('refresh') === '1');
  if (refreshRequested && typeof detector.invalidate === 'function') detector.invalidate();
  const entries = detector.detect();
  const capabilities = typeof detector.detectCapabilities === 'function'
    ? detector.detectCapabilities()
    : {};
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
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    entries,
    capabilities,
    runningAccounts,
    runningAccountPids,
    runningCliAccounts,
    runningCliAccountPids
  });
  return true;
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

async function handleUpdateAccountStatusRequest(ctx) {
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
  let updated = false;
  if (accountStateService && typeof accountStateService.setOperationalStatus === 'function') {
    const nextState = buildPersistedAccountState(ctx, provider, accountRef, stateRow, { status: nextStatus });
    updated = accountStateService.setOperationalStatus(accountRef, provider, nextStatus, nextState);
  }
  if (!updated) {
    writeJson(ctx.res, 500, { ok: false, error: 'update_status_failed' });
    return true;
  }

  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}

  // 停用 Codex 账号必须同时回收宿主直连授权，否则裸 codex / 桌面 App 会继续
  // 绕过网关直连该账号（停用对它们无效）。
  const hostGrantRevoke = nextStatus === 'down' ? revokeHostGrantHook(ctx, provider, accountRef) : null;
  if (hostGrantRevoke && hostGrantRevoke.revoked) {
    try { reloadDesktopRuntimeHook(ctx, provider); } catch (_error) {}
  }

  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account, ...(hostGrantRevoke ? { hostGrantRevoke } : {}) });
  return true;
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

  // provider 自己的凭据写入规则（env 键名 / Claude 的认证方式切换）由补丁注册表回答。
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
  const {
    pathname, accountStateIndex, accountStateService, readRequestBody,
    state, fs, writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/routing-rules$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
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
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  // 只有第三方/自建上游的 API Key 账号有可对齐的错误码：OAuth 登录态与官方地址账号
  // 走厂商标准错误码（判定见 upstream-routing-rules-eligibility）。
  const rejection = resolveRoutingRulesUpstreamRejection(ctx, provider, accountRef);
  if (rejection) {
    writeJson(ctx.res, 400, rejection);
    return true;
  }
  let rules;
  try {
    rules = validateUpstreamErrorRules(payload.upstreamErrorRules || []);
  } catch (error) {
    writeJson(ctx.res, 400, { ok: false, error: error.code, message: error.message });
    return true;
  }
  const groupIds = readUpstreamErrorGroupIds({
    [ERROR_RULE_GROUP_IDS_ENV_KEY]: JSON.stringify(payload.upstreamErrorGroupIds || [])
  });
  const aiHomeDir = resolveAiHomeDir(ctx);
  const available = new Set(readUpstreamErrorMappingGroups(fs, aiHomeDir).groups.map((group) => group.id));
  if (groupIds.some((id) => !available.has(id))) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_upstream_error_group', message: '存在未找到的异常映射组。' });
    return true;
  }
  const currentEnv = readAccountCredentials(fs, aiHomeDir, accountRef) || {};
  const nextEnv = { ...currentEnv };
  if (rules.length) nextEnv[ERROR_RULES_ENV_KEY] = JSON.stringify(rules);
  else delete nextEnv[ERROR_RULES_ENV_KEY];
  if (groupIds.length) nextEnv[ERROR_RULE_GROUP_IDS_ENV_KEY] = JSON.stringify(groupIds);
  else delete nextEnv[ERROR_RULE_GROUP_IDS_ENV_KEY];
  writeAccountCredentials(fs, aiHomeDir, accountRef, nextEnv, { preserveCredentialTimestamp: true });
  if (payload.clearErrorBlock === true) {
    clearAccountRoutingBlock(ctx, provider, accountRef, accountStateService);
  }
  try { reloadRuntimeAccountsIfNeeded(ctx, provider); } catch (_error) {}
  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account });
  return true;
}

async function handleSetDefaultAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateIndex,
    getProfileDir,
    ensureSessionStoreLinks,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

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
  const accountState = buildPersistedAccountState(ctx, provider, accountRef, stateRow);
  let liveAccount = null;
  try {
    liveAccount = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
  } catch (_error) {}
  const runtimeAccount = findRuntimeAccount(ctx, provider, accountRef);
  const runtimeStatus = deriveAccountRuntimeStatus(runtimeAccount);
  const eligibility = evaluateDefaultAccountEligibility({
    ...accountState,
    ...(liveAccount || {}),
    authPending: isPendingOauthStateRow(provider, stateRow),
    runtimeStatus: pickBlockingStatusValue(
      'healthy',
      liveAccount && liveAccount.runtimeStatus,
      runtimeAccount && runtimeAccount.runtimeStatus,
      runtimeStatus.status
    ),
    schedulableStatus: pickBlockingStatusValue(
      'schedulable',
      liveAccount && liveAccount.schedulableStatus,
      runtimeAccount && runtimeAccount.schedulableStatus,
      stateRow && stateRow.schedulableStatus
    )
  });
  if (!eligibility.allowed) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'set_default_unsupported',
      code: eligibility.code,
      message: eligibility.message
    });
    return true;
  }

  const syncGlobalConfigToHost = deps && deps.syncGlobalConfigToHost;
  if (typeof syncGlobalConfigToHost !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'set_default_unavailable' });
    return true;
  }

  try {
    if (typeof ensureSessionStoreLinks === 'function') {
      ensureSessionStoreLinks(provider, accountRef);
    }
    const syncResult = syncGlobalConfigToHost(provider, accountRef);
    if (!syncResult || !syncResult.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_default_sync_failed',
        reason: syncResult && syncResult.reason ? syncResult.reason : 'unknown_error'
      });
      return true;
    }
    const aiHomeDir = resolveAiHomeDir(ctx);
    if (!aiHomeDir) {
      writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
      return true;
    }
    writeDefaultAccountRef(fs, aiHomeDir, provider, accountRef);
    // 显式指定了默认账号就必须撤掉 AIH Server 档位：启动链路先看档位
    // （provider:default:<provider> = aih_server），残留会让刚设置的账号被静默忽略。
    clearDefaultProviderProfile(fs, aiHomeDir, provider);
    const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountRef, account, ...(desktopRuntime ? { desktopRuntime } : {}) });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_default_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleClearDefaultAccountRequest(ctx) {
  const {
    pathname,
    fs,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  try {
    const aiHomeDir = resolveAiHomeDir(ctx);
    if (!aiHomeDir) {
      writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
      return true;
    }
    const clearedDefault = clearDefaultAccountRef(fs, aiHomeDir, provider, accountRef);
    // 清除默认后宿主仍可能留着该账号的直连端点与钉选（历史上 clear-default
    // 只删记录不同步宿主），一并回收，否则默认清了但直连还在。
    const hostGrantRevoke = revokeHostGrantHook(ctx, provider, accountRef);
    // 默认账号一旦不再指定，落点就是 AIH Server（与 `aih <provider> set-default`
    // 不带账号号同义）：宿主回网关档 + 档位记 aih_server。真正清掉指针与收回
    // 残留授权（宿主已被改写）两种情形都要落，否则会停在「无默认」的裸跑直连态。
    const aihServerDefault = (clearedDefault || Boolean(hostGrantRevoke && hostGrantRevoke.revoked))
      ? landOnAihServerDefault({
        fs,
        aiHomeDir,
        provider,
        syncGlobalConfigToHost: ctx.deps && ctx.deps.syncGlobalConfigToHost
      })
      : { ok: true, landed: false, reason: 'no_default_change' };
    const desktopRuntime = reloadDesktopRuntimeHook(ctx, provider);
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      account,
      aihServerDefault,
      ...(hostGrantRevoke ? { hostGrantRevoke } : {}),
      ...(desktopRuntime ? { desktopRuntime } : {})
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'clear_default_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleSetMobileAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'set-mobile')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const validation = validateCodexDesktopAccount(ctx.fs, {
    accountRef,
    aiHomeDir: resolveAiHomeDir(ctx),
    processObj: deps && deps.processObj
  });
  if (!validation.ok) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'mobile_account_invalid',
      code: validation.code,
      message: 'Codex App 账号需要可用的 ChatGPT OAuth 授权。'
    });
    return true;
  }

  try {
    const result = setCodexDesktopAccount(ctx, accountRef);
    if (!result || !result.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_mobile_failed',
        reason: result && result.reason ? result.reason : 'unknown_error'
      });
      return true;
    }
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      account,
      hotSyncQueued: Boolean(result.sync && result.sync.queued),
      desktopRuntime: result.reload
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_mobile_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleClearMobileAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'clear-mobile')) return true;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  try {
    const result = clearCodexDesktopAccount(ctx, accountRef);
    if (!result || !result.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'clear_mobile_failed',
        reason: result && result.reason ? result.reason : 'unknown_error'
      });
      return true;
    }
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      account,
      hotSyncQueued: Boolean(result.sync && result.sync.queued),
      desktopRuntime: result.reload
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'clear_mobile_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

// 强杀重试标记：前端在用户确认「终止占用者并继续删除」后带 ?force=1 重发。
function isForceDeleteRequest(ctx) {
  const url = ctx.url;
  const raw = url && url.searchParams ? url.searchParams.get('force') : '';
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return value === '1' || value === 'true';
}

// 占用者 -> 人能读的原因文案。会话条数与会话标识都带上，用户才能判断该不该强杀。
function buildOccupancyMessage(items = []) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '该账号仍被占用，无法删除。';
  const labels = Array.from(new Set(list.map((item) => String(item && item.label || '').trim()).filter(Boolean)));
  const detail = list
    .map((item) => String(item && (item.sessionId || item.session || item.detail) || '').trim())
    .filter(Boolean);
  const suffix = detail.length > 0 ? `（${detail.slice(0, 5).join('、')}${detail.length > 5 ? ' 等' : ''}）` : '';
  return `该账号有 ${labels.join('、')} 正在占用${suffix}，删除会终止它们。`;
}

function buildReleaseFailureMessage(failed = []) {
  const list = Array.isArray(failed) ? failed : [];
  const labels = Array.from(new Set(list.map((item) => String(item && item.label || '').trim()).filter(Boolean)));
  const reason = list.map((item) => String(item && item.reason || '').trim()).filter(Boolean)[0] || '';
  const base = labels.length > 0
    ? `无法终止 ${labels.join('、')}，账号未删除。`
    : '无法终止占用该账号的进程，账号未删除。';
  return reason ? `${base}（${reason}）` : base;
}

async function handleDeleteAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateService,
    writeJson
  } = ctx;
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
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const forceRequested = isForceDeleteRequest(ctx);
  const occupancyTarget = {
    provider,
    accountRef,
    aiHomeDir: resolveAiHomeDir(ctx)
  };
  try {
    // 占用者探测是删除的**第一道门**：先如实列出谁在占用（运行中的会话 / agy 常驻
    // 进程 / tmux 挂起的持久会话），让前端能提示原因；用户确认后带 force 重试，
    // 这里先把占用者逐个释放，再走下面的正常删除。
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

async function handleExportAccountsRequest(ctx) {
  const { fs, aiHomeDir, url } = ctx;
  try {
    const requestedFormat = url && url.searchParams && url.searchParams.get('format');
    if (isRemovedWebExportFormat(requestedFormat)) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'unsupported_export_format' });
      return true;
    }
    const format = normalizeWebExportFormat(requestedFormat);
    if (!format) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'unsupported_export_format' });
      return true;
    }

    const payload = buildWebExportPayload({
      fs,
      aiHomeDir,
      format
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${webExportFileName(format)}"`
    });
    ctx.res.end(`${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch (_error) {
    ctx.writeJson(ctx.res, 500, { ok: false, error: 'export_failed' });
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
  handleExportAccountsRequest,
  handleImportAccountsRequest,
  inferReauthAuthMode
};
