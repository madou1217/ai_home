'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  readAccountCredentialRecord,
  readAccountCredentials,
  writeAccountCredentials
} = require('./account-credential-store');
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
  serializeAuthJob
} = require('./web-account-auth');
const {
  getClaudeCredentialType,
  writeClaudeCredentialEnv
} = require('../account/claude-credential');
const {
  buildAntigravityManagerExportPayload,
  buildSub2ApiExportPayload,
  importStandardAccountRecords
} = require('../account/standard-transfer');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const {
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
  writeDefaultAccountRef
} = require('../account/default-account-store');
const {
  resolveAccountRef,
  listAccountRefRecords
} = require('./account-ref-store');
const { deriveRuntimeStatus } = require('../account/runtime-view');
const { resolveClientPlatform, CLIENT_PLATFORMS } = require('../runtime/client-platform');
const { getAppInstallJobManager } = require('./webui-app-install-routes');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { evaluateDefaultAccountEligibility } = require('./account-default-eligibility');
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
  ZCODE_EGRESS_BINDING_UNAVAILABLE
]);

const ACCOUNT_APP_SERVICE_UNAVAILABLE_ERRORS = new Set([
  'agy_desktop_process_probe_failed',
  ZCODE_EGRESS_UNAVAILABLE
]);

const ACCOUNT_APP_ERROR_MESSAGES = Object.freeze({
  agy_desktop_keychain_conflict: '检测到其他 Antigravity Desktop 实例。macOS Keychain 是全局凭据，请先关闭其他实例后再打开此账号。',
  agy_desktop_restart_required: '该账号的 Antigravity Desktop 仍在使用旧凭据，请关闭后重新打开以加载当前账号凭据。',
  agy_desktop_auth_unavailable: '当前账号没有可用的 Antigravity OAuth 凭据，未启动 Desktop。',
  agy_desktop_process_probe_failed: '无法确认 Antigravity Desktop 实例状态，为避免覆盖全局凭据已停止启动。',
  kimi_desktop_session_required: '该账号尚未完成 Kimi Desktop 托管登录，请先扫码后再打开。',
  kimi_desktop_session_seed_failed: 'Kimi Desktop 登录态写入失败，未启动未登录的应用实例。',
  kimi_desktop_restart_failed: 'Kimi Desktop 登录态已准备，但旧实例未能结束；为保证同账号单实例，未启动新实例。',
  zcode_egress_binding_unavailable: 'ZCode 出口绑定无法读取，为避免直连降级，Desktop 未启动；现有原生设置保持不变。',
  zcode_egress_unavailable: 'ZCode 账号出口当前不可用，为避免绕过绑定，Desktop 未启动；请检查 sing-box、代理地址或节点配置后重试。',
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
const { createDesktopLoginQRCode, getDesktopLoginQRCodeStatus, writeDesktopSession } = require('./kimi-desktop-session');
async function handleListAccountsRequest(ctx) {
  return handleListAccountsFastRequest(ctx);
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
  const config = payload.config || {};
  const replaceExisting = Boolean(payload.replaceExisting);
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
        config: provider === 'claude'
          ? { ...config, credentialType: authMode }
          : config,
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
      ? manager.startOauthJobWithInstallConfirmation(provider, authMode)
      : manager.startOauthJob(provider, authMode);
    writeJson(ctx.res, 200, buildPendingOauthResponse(started, authMode));
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
  if (provider === 'agy' && !(await agyWarmPool.evict(accountRef))) {
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
async function handleKimiDesktopSessionStartRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/start$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (provider !== 'kimi') {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const result = await createDesktopLoginQRCode({
    fetchImpl: ctx.deps && ctx.deps.fetchImpl
  }).catch((error) => ({ ok: false, error: `create_qrcode_failed:${String(error && error.message || error).slice(0, 120)}` }));
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
  if (provider !== 'kimi') {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
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
  const result = await getDesktopLoginQRCodeStatus({
    fetchImpl: ctx.deps && ctx.deps.fetchImpl
  }, code).catch((error) => ({ ok: false, error: `qrcode_status_failed:${String(error && error.message || error).slice(0, 120)}` }));
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

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  const routeDeps = ctx.deps || {};

  const launcher = createWebUiAccountAppLauncher(ctx, provider, accountRef, action);
  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: { provider, accountRef, kind, action, terminalId },
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
      const installTarget = {
        provider,
        kind,
        appId: kind === 'desktop' ? `${provider}-desktop` : provider
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

  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account });
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
  const requestedClaudeCredentialType = provider === 'claude'
    ? getClaudeCredentialType({
        credentialType: payload && (payload.credentialType || payload.authType || payload.authMode)
      })
    : '';

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

  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
    return;
  }
  const credentialEnv = readAccountCredentials(fs, aiHomeDir, accountRef) || {};
  const effectiveBaseUrl = payload && 'baseUrl' in payload
    ? baseUrl
    : (
        provider === 'codex'
          ? String(credentialEnv.OPENAI_BASE_URL || '').trim()
          : provider === 'claude'
          ? String(credentialEnv.ANTHROPIC_BASE_URL || '').trim()
          : provider === 'agy'
          ? String(credentialEnv.AGY_BASE_URL || '').trim()
          : provider === 'gemini'
          ? String(credentialEnv.GEMINI_BASE_URL || '').trim()
          : ''
      );
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

  if (provider === 'codex') {
    if (apiKey) nextCredentialEnv.OPENAI_API_KEY = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.OPENAI_BASE_URL = baseUrl;
      else delete nextCredentialEnv.OPENAI_BASE_URL;
    }

  } else if (provider === 'gemini') {
    if (apiKey) {
      nextCredentialEnv.GEMINI_API_KEY = apiKey;
      nextCredentialEnv.GOOGLE_API_KEY = apiKey;
    }
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.GEMINI_BASE_URL = baseUrl;
      else delete nextCredentialEnv.GEMINI_BASE_URL;
    }
  } else if (provider === 'agy') {
    if (apiKey) nextCredentialEnv.AGY_ACCESS_TOKEN = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.AGY_BASE_URL = baseUrl;
      else delete nextCredentialEnv.AGY_BASE_URL;
    }
  } else if (provider === 'claude') {
    const currentCredentialType = getClaudeCredentialType({ env: nextCredentialEnv }) || 'api-key';
    const nextCredentialType = requestedClaudeCredentialType || currentCredentialType;
    if (requestedClaudeCredentialType && requestedClaudeCredentialType !== currentCredentialType && !apiKey) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'credential_required_for_auth_type_switch',
        message: '切换 Claude 认证方式时需要重新输入密钥。'
      });
      return true;
    }
    const credentialPatch = {
      credentialType: nextCredentialType,
      token: apiKey
    };
    if (payload && 'baseUrl' in payload) credentialPatch.baseUrl = baseUrl;
    const nextEnvJson = writeClaudeCredentialEnv(nextCredentialEnv, credentialPatch);
    Object.keys(nextCredentialEnv).forEach((key) => {
      delete nextCredentialEnv[key];
    });
    Object.assign(nextCredentialEnv, nextEnvJson);
    updatedClaudeCredentialType = getClaudeCredentialType({ env: nextCredentialEnv }) || nextCredentialType;
  }

  writeAccountCredentials(fs, aiHomeDir, accountRef, nextCredentialEnv);
  if (authSnapshotBefore && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
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
  invalidateModelCacheForAccountRefs(ctx, [accountRef]);
  if (provider === 'claude' && updatedClaudeCredentialType && account) {
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
    const desktopRuntime = provider === 'codex'
      ? reloadCodexDesktopRuntime(resolveCodexDesktopHookService(ctx))
      : null;
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
    clearDefaultAccountRef(fs, aiHomeDir, provider, accountRef);
    const desktopRuntime = provider === 'codex'
      ? reloadCodexDesktopRuntime(resolveCodexDesktopHookService(ctx))
      : null;
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountRef, account, ...(desktopRuntime ? { desktopRuntime } : {}) });
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
  if (provider !== 'codex') {
    writeJson(ctx.res, 400, { ok: false, error: 'mobile_account_unsupported' });
    return true;
  }
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
  if (provider !== 'codex') {
    writeJson(ctx.res, 400, { ok: false, error: 'mobile_account_unsupported' });
    return true;
  }
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
  try {
    assertNoActiveNativeRunBeforeDelete(ctx, provider, accountRef);
    await evictAgyWarmWriterBeforeDelete(ctx, provider, accountRef);
    const aiHomeDir = resolveAiHomeDir(ctx);
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
    writeJson(ctx.res, 200, { ok: true });
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
  handleGetImportJobRequest,
  handleGetAddJobRequest,
  handleCancelAddJobRequest,
  handleConfirmAddJobInstallRequest,
  handleCompleteAddJobCallbackRequest,
  handleAddAccountRequest,
  handleRefreshAccountUsageRequest,
  handleKimiDesktopSessionStartRequest,
  handleKimiDesktopSessionPollRequest,
  createWebUiAccountAppLauncher,
  resolveAccountAppErrorMessage,
  resolveAccountAppErrorStatus,
  handleOpenAccountAppRequest,
  handleListAppEntriesRequest,
  handleUpdateAccountStatusRequest,
  handleUpdateAccountRequest,
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
