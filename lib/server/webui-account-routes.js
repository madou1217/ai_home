'use strict';

const path = require('node:path');
const {
  isCustomUpstreamAccount
} = require('../account/official-upstream-endpoint');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  getDefaultAuthMode,
  isSupportedAuthMode,
  normalizeAuthMode,
  serializeAuthJob,
  isSupportedAuthStrategy
} = require('./web-account-auth');
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
const { reloadCodexDesktopRuntime } = require('./codex-desktop-runtime-reload');
const { createAccountRemovalService } = require('../account/account-removal');
const agyWarmPool = require('./agy-warm-ls-pool');
const { getAppInstallJobManager } = require('./webui-app-install-routes');
const { createWebUiAccountAppLauncher } = require('./webui-account-app-launcher');
const { callGoHost } = require('./webui-go-proxy');
const {
  getTrackedJob,
  findTrackedJobByState,
  cancelTrackedGoJobForProvider,
  completeGoReauthCallback,
  cancelGoReauthJob,
  confirmGoAddJobInstall,
  localImportGoAddJob,
  tryGoReauth,
  tryGoAddAccount,
  completeGoZcodeUrlCallback,
  importStaticAccountViaGo,
  importLocalAuthViaGo
} = require('./webui-account-go-reauth');

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

const { invalidateModelCacheForAccountRefs, buildPendingOauthResponse, reloadRuntimeAccountsIfNeeded, parseAccountRoute, isSelfRelayBaseUrl, writeSelfRelayAccountRejected, resolveAiHomeDir, inferReauthAuthMode, buildCallbackErrorMessage } = require('./webui-account-routes-utils');
const { applyAliasPoolPreference, readAliasPoolParticipates } = require('../account/alias-pool-preference');
const {
  resolveCodexDesktopHookService,
  setCodexDesktopAccount,
  clearCodexDesktopAccount
} = require('./webui-account-routes-desktop');
const { emitAccountRefreshJobEvent, serializeAccountRefreshJob } = require('./webui-account-routes-refresh');
const { evictAgyWarmWriterBeforeDelete, hasActiveNativeAccountRun } = require('./webui-account-routes-delete');
const {
  detectDeletionBlockers,
  releaseDeletionBlockers
} = require('./account-deletion-occupancy');
const { proxyGo } = require('./webui-go-proxy');
const { publishAccountLifecycleEvent } = require('./account-lifecycle-bus');
const { credentialsEqual, isDirectLoopbackRequest, parseBearerCredential } = require('./management-key-auth');
async function handleListAccountsRequest(ctx) {
  return handleListAccountsFastRequest(ctx);
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
  // Go 承接的重新认证作业：快照在本地跟踪器里（含回调捕获与进度）。
  const trackedJob = getTrackedJob(matches[1]);
  if (trackedJob) {
    writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(trackedJob) });
    return true;
  }
  // Go 的活跃作业快照：re-auth 直接由 Go 启动时，Node 内存里没有这条作业。
  try {
    const goHost = ctx.deps && ctx.deps.goCoreSync;
    if (goHost && typeof goHost.webuiRequest === 'function') {
      const goJob = await goHost.webuiRequest({
        method: 'GET',
        path: `/v1/management/webui/account-jobs/${encodeURIComponent(matches[1])}`
      });
      if (goJob && goJob.ok === true && goJob.data && goJob.data.job) {
        writeJson(ctx.res, 200, { ok: true, job: goJob.data.job, recovered: Boolean(goJob.data.recovered) });
        return true;
      }
    }
  } catch (_error) {}
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
    if (result.code === 'job_not_found' && getTrackedJob(matches[1])) {
      // Go 承接的重新认证作业：取消必须落到 Go，否则作业会一直占用 Provider。
      const goResult = await cancelGoReauthJob(ctx, matches[1]);
      if (goResult.ok) {
        writeJson(ctx.res, 200, {
          ok: true,
          ...(goResult.job ? { job: goResult.job } : {})
        });
        return true;
      }
      writeJson(ctx.res, 400, { ok: false, error: goResult.code || 'cancel_failed' });
      return true;
    }
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
  // Go 承接的 OAuth 作业不依赖本地 CLI：与本地「不需要安装」的作业同一结论。
  const trackedJob = getTrackedJob(matches[1]);
  if (trackedJob) {
    const result = await confirmGoAddJobInstall(ctx, matches[1]);
    if (result.ok) {
      writeJson(ctx.res, 200, { ok: true, ...(result.job ? { job: result.job } : {}) });
      return true;
    }
    const code = String(result.code || 'install_failed');
    const statusCode = code === 'job_not_found'
      ? 404
      : (code === 'go_auth_job_unavailable' ? 502 : 400);
    writeJson(ctx.res, statusCode, {
      ok: false,
      error: code,
      code,
      ...(result.message ? { message: result.message } : {}),
      ...(result.job ? { job: result.job } : {})
    });
    return true;
  }
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
  const { readRequestBody, writeJson } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const url = String(payload && payload.url || '').trim();
  const state_ = String(payload && payload.state || '').trim();
  if (!url || !state_) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_callback_payload' });
    return true;
  }
  const goResult = await completeGoZcodeUrlCallback(ctx, url, state_);
  writeJson(ctx.res, goResult.status || (goResult.ok ? 200 : 500), goResult.data || {
    ok: Boolean(goResult.ok),
    error: goResult.ok ? undefined : 'callback_forward_failed'
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

  // Go 承接的重新认证作业：回调原样交给 Go（state/PKCE 只存在 Go 进程内）。
  if (getTrackedJob(matches[1])) {
    const goResult = await completeGoReauthCallback(ctx, matches[1], callbackUrl);
    const code = String(goResult.code || '');
    if (goResult.ok) {
      writeJson(ctx.res, 200, { ok: true, job: goResult.job });
      return true;
    }
    const statusCode = code === 'job_not_found'
      ? 404
      : (goResult.retryable ? 502 : 400);
    const message = code === 'go_auth_job_unreachable' || code === 'go_auth_job_unavailable'
      ? '无法连接 Go 登录服务，请确认 server 仍在运行后重新提交回调。'
      : buildCallbackErrorMessage(code);
    writeJson(ctx.res, statusCode, {
      ok: false,
      error: code || 'callback_forward_failed',
      code: code || 'callback_forward_failed',
      message,
      ...(goResult.job ? { job: goResult.job } : {})
    });
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
  // Go 承接的新增作业：本机导入不在 Go 的 OAuth Flow 里，转发给 Go 拿稳定结论，
  // 不把「Go 作业不存在于本地 manager」误报成 job_not_found。
  if (getTrackedJob(matches[1])) {
    const result = await localImportGoAddJob(ctx, matches[1], sourceId);
    if (result.ok) {
      writeJson(ctx.res, 200, { ok: true, job: result.job });
      return true;
    }
    const code = String(result.code || 'local_import_failed');
    // 优先保留 Go 的稳定状态（501 = 该作业没有本机导入实现），不要重写成 409。
    const statusCode = Number(result.status) >= 400
      ? Number(result.status)
      : (code === 'job_not_found' ? 404 : (code === 'missing_source_id' ? 400 : 409));
    writeJson(ctx.res, statusCode, {
      ok: false, error: code, code,
      message: String(result.message || ''),
      job: result.job || null
    });
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
  const { readRequestBody, writeJson } = ctx;
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
  const goResult = await importLocalAuthViaGo(ctx, {
    provider,
    sourceId,
    aliasPoolParticipates
  });
  if (!goResult.ok) {
    writeJson(ctx.res, goResult.status || 500, goResult.data || {
      ok: false,
      error: 'local_auth_import_failed'
    });
    return true;
  }
  const data = goResult.data && typeof goResult.data === 'object' ? goResult.data : {};
  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}
  const account = data.accountRef
    ? await refreshLiveAccountRecord(ctx, provider, data.accountRef, { skipUsageRefresh: true })
    : null;
  writeJson(ctx.res, 200, {
    ok: true,
    provider,
    accountRef: data.accountRef || '',
    cliAccountId: data.cliAccountId || '',
    sourceId: data.sourceId || sourceId,
    ...(account ? { account } : {})
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
    if (authMode === 'api-key' || authMode === 'auth-token' || authMode === 'vertex-ai') {
      const serverPort = Number(ctx && ctx.options && ctx.options.port) || 0;
      const goResult = await importStaticAccountViaGo(ctx, {
        provider,
        authMode,
        config,
        serverPort,
        aliasPoolParticipates
      });
      if (!goResult.ok) {
        writeJson(ctx.res, goResult.status || 500, goResult.data || {
          ok: false,
          error: 'add_account_failed'
        });
        return true;
      }
      const data = goResult.data && typeof goResult.data === 'object' ? goResult.data : {};
      try {
        reloadRuntimeAccountsIfNeeded(ctx, provider);
      } catch (_error) {}
      const account = data.accountRef
        ? await refreshLiveAccountRecord(ctx, provider, data.accountRef, { skipUsageRefresh: true })
        : null;
      writeJson(ctx.res, 200, {
        ...data,
        ...(account ? { account } : {})
      });
      return true;
    }

    const loginProvider = String((config && config.loginProvider) || payload.loginProvider || '').trim();
    const manager = getAuthJobManager(deps, state);
    if (replaceExisting) {
      const activeJob = manager.getRunningJob(provider);
      if (activeJob) {
        manager.cancelJob(activeJob.id);
        cleanupAuthJobArtifacts(activeJob, deps, state);
      }
      // Go 承接的同 Provider 作业不在本地 manager 里：切换登录方式/替换时也要释放它，
      // 否则 Go 侧的活动作业会让新作业直接 409。
      await cancelTrackedGoJobForProvider(ctx, provider);
    }
    // 先让 Go 承接：作业状态、PKCE/state 与账号写入都在 Go 进程内，Node 只保留
    // loopback 回调捕获与 watch 事件投影。Provider/认证方式未迁 Go 时回落本地流程。
    // 本地已有运行中作业时把 id 带进桥接层：Go 的 409 需要它，前端才能打开现有进度。
    const goResult = await tryGoAddAccount(ctx, {
      provider,
      authMode,
      authStrategy,
      loginProvider,
      runningJob: manager.getRunningJob(provider),
      aliasPoolParticipates,
      onSucceeded: (tracker) => {
        // 新增账号的「是否进入别名选号池」偏好只有作业成功、accountRef 落库后才有意义。
        if (!tracker || !tracker.accountRef) return null;
        // Go 与 Node 的身份派生规则不同（zcode 的区域参与 Node 身份）：偏好必须写在
        // Node 账号键上，否则账号级「不入池」开关对不上这条记录。
        let accountRef = tracker.accountRef;
        const goHost = deps && deps.goCoreSync;
        if (goHost && typeof goHost.nodeAccountRefFor === 'function') {
          try {
            accountRef = String(goHost.nodeAccountRefFor(accountRef) || accountRef);
          } catch (_error) {
            // 映射失败时保留 Go 键，宁可偏好写不上也不要写错账号。
          }
        }
        return applyAliasPoolPreference(fs, resolveAiHomeDir(ctx), accountRef, aliasPoolParticipates);
      }
    });
    if (goResult.handled) return true;
    const started = typeof manager.startOauthJobWithInstallConfirmation === 'function'
      ? manager.startOauthJobWithInstallConfirmation(provider, authMode, {
        // kiro 的 social 设备流（Google / Github）由这个字段选择；缺省 = Builder ID 的 OIDC 口径。
        loginProvider,
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
    readRequestBody,
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

  let bodyPayload = null;
  if (typeof readRequestBody === 'function') {
    bodyPayload = await readRequestBody(ctx.req, { maxBytes: 16 * 1024 })
      .then((buf) => (buf && buf.length > 0 ? JSON.parse(buf.toString('utf8')) : null))
      .catch(() => null);
  }

  const activeNativeRun = Boolean(hasActiveNativeAccountRun(ctx, provider, accountRef));
  if (activeNativeRun) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: '请先停止该账号正在运行的会话，再重新认证。'
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

  // 全量切换至 Go webuiaccountreauthapi：账号校验、authMode/strategy 推断、PKCE/state 与
  // 持久化写入全部在 Go 进程内执行，Go 不可用直接 503 失败关闭（零 Node 回退）。
  await tryGoReauth(ctx, {
    provider,
    accountRef,
    authMode: bodyPayload && typeof bodyPayload === 'object' ? String(bodyPayload.authMode || '').trim() : '',
    authStrategy: bodyPayload && typeof bodyPayload === 'object' ? String(bodyPayload.authStrategy || '').trim() : '',
    loginProvider: bodyPayload && typeof bodyPayload === 'object' ? String(bodyPayload.loginProvider || '').trim() : '',
    activeNativeRun,
    requireGo: true
  });
  return true;
}

// ── Go 异步额度刷新（refresh-usage）─────────────────────────────────────────
// Go 把额度探测包成异步作业：202 返回 queued 的 job，状态靠 refresh-jobs 轮询推进。
// Node 只做契约翻译：先回 202 让前端挂上 SSE，再把作业状态变化推成 account-refresh-job。
const GO_USAGE_REFRESH_POLL_INTERVAL_MS = 300;
const GO_USAGE_REFRESH_POLL_TIMEOUT_MS = 30 * 1000;

function delayUsageRefreshPoll(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 轮询计时器不作为进程存活理由（与服务内其它后台计时器一致）。
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// 轮询 Go 作业并把状态变化推成 SSE；终态成功后让账号读模型从规范源重取一次。
// 只在状态变化时推事件（queued → running → 终态），不按轮询节奏刷屏。
async function trackGoAccountRefreshJob(ctx, initialJob, options = {}) {
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  const jobId = String((initialJob && initialJob.id) || '').trim();
  const nodeAccountRef = String(options.nodeAccountRef || (initialJob && initialJob.accountRef) || '').trim();
  if (!jobId || !goHost || typeof goHost.getRefreshJob !== 'function') return;
  const deadline = Date.now() + GO_USAGE_REFRESH_POLL_TIMEOUT_MS;
  let job = nodeAccountRef ? { ...initialJob, accountRef: nodeAccountRef } : initialJob;
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
    job = nodeAccountRef ? { ...next, accountRef: nodeAccountRef } : next;
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

  const goHost = deps && deps.goCoreSync;
  const goEnabled = !goHost || typeof goHost.isEnabled !== 'function' || goHost.isEnabled();
  if (!goHost || !goEnabled || typeof goHost.refreshAccountUsageWebUI !== 'function') {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 额度刷新服务不可用'
    });
    return true;
  }

  let goResult = null;
  try {
    goResult = await goHost.refreshAccountUsageWebUI(provider, accountRef);
  } catch (_error) {
    goResult = null;
  }
  if (goResult && String(goResult.errorCode || '') === 'timeout') {
    writeJson(ctx.res, 504, {
      ok: false,
      error: 'refresh_timeout',
      message: '刷新账号额度超时，请稍后重试。'
    });
    return true;
  }
  const goJob = goResult && goResult.ok && goResult.data && goResult.data.job
    ? goResult.data.job
    : null;
  if (goJob) {
    const normalizedJob = { ...goJob, accountRef };
    emitAccountRefreshJobEvent(ctx, normalizedJob);
    writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: Boolean(goResult.data.alreadyRunning),
      job: serializeAccountRefreshJob(normalizedJob)
    });
    trackGoAccountRefreshJob(ctx, normalizedJob, { nodeAccountRef: accountRef }).catch(() => {});
    return true;
  }
  const status = Number((goResult && goResult.status) || 0);
  const errorCode = String((goResult && goResult.errorCode) || '').trim();
  if (!goResult || status === 0 || errorCode === 'go_core_unavailable' || errorCode === 'network_error') {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 额度刷新服务不可用'
    });
    return true;
  }
  if (status >= 400 && goResult.data && typeof goResult.data === 'object') {
    writeJson(ctx.res, status, goResult.data);
    return true;
  }
  writeJson(ctx.res, status >= 400 ? status : 503, {
    ok: false,
    error: (goResult.data && (goResult.data.error || goResult.data.code)) || errorCode || 'go_core_unavailable',
    message: (goResult.data && goResult.data.message) || 'Go Core 额度刷新失败'
  });
  return true;
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

function reloadDesktopRuntimeHook(ctx, provider) {
  const hook = getAccountLifecycle(provider);
  if (!hook || typeof hook.reloadDesktopRuntime !== 'function') return null;
  return hook.reloadDesktopRuntime(ctx);
}

// kimi 的桌面端托管登录与套餐统计由 Go 承接（webuiaccountkimiapi）：官方 QR RPC、
// Membership RPC、web session 托管与账号级出口解析都在 Go 进程内。Node 只保留
// 协议外壳（路径/作用域/请求体校验与 SSE 字节透传），Go 不可用时明确 503，
// 不再回落到本进程的 kimi-desktop-session / kimi-plan-stats。
const KIMI_GO_PASS_STATUSES = Object.freeze([400, 404, 409, 500, 502, 503]);

// POST /v0/webui/accounts/kimi/:accountRef/desktop-session/start
async function handleKimiDesktopSessionStartRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/start$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/start')) return true;
  return proxyGo(ctx, {
    method: 'startKimiDesktopSession',
    args: [provider, accountRef],
    message: 'Go Core 未就绪，Kimi 桌面端登录未发起',
    passStatuses: KIMI_GO_PASS_STATUSES
  });
}

// POST /v0/webui/accounts/kimi/:accountRef/desktop-session/poll {code}
async function handleKimiDesktopSessionPollRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/poll$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/poll')) return true;
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const code = String(payload && payload.code || '').trim();
  if (!code) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_code' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'pollKimiDesktopSession',
    args: [provider, accountRef, code],
    message: 'Go Core 未就绪，Kimi 扫码状态不可读',
    passStatuses: KIMI_GO_PASS_STATUSES,
    transform: async (data) => {
      // Go 已把会话写进账号凭据；Node 运行池/桌面启动读的是本机 app-state 镜像，
      // 扫码成功后立刻对账一次（这是状态同步，不是轮询）。
      if (data && data.status === 'STATUS_SUCCESS') {
        await reconcileKimiAccounts(ctx);
      }
      return data;
    }
  });
}

// GET /v0/webui/accounts/kimi/:accountRef/desktop-session/watch?code=...
// SSE 桥：2s 的上游轮询节奏在 Go 领域层，Node 只透传事件字节。
async function handleKimiDesktopSessionWatchRequest(ctx) {
  const { pathname, url, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/desktop-session\/watch$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'desktop-session/watch')) return true;
  const code = String((url && url.searchParams && url.searchParams.get('code')) || '').trim();
  if (!code) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_code' });
    return true;
  }
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.watchKimiDesktopSession !== 'function') {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Kimi 扫码状态由 Go 提供，当前不可用'
    });
    return true;
  }
  const stream = await goHost.watchKimiDesktopSession(provider, accountRef, code).catch(() => null);
  if (!stream || !stream.ok || !stream.body) {
    writeJson(ctx.res, 503, {
      ok: false,
      error: String((stream && stream.errorCode) || 'go_core_unavailable'),
      message: 'Kimi 扫码状态由 Go 提供，当前不可用'
    });
    return true;
  }
  const { res } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => { try { stream.abort?.(); } catch (_error) {} };
  res.on('close', abort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (_error) {
    // 浏览器或 Go 任一端断开：EventSource 会自行重连。
  } finally {
    res.end();
    abort();
    // 流结束意味着 Go 已到终态（成功/过期）或断开；成功时把凭据同步进 Node 镜像。
    await reconcileKimiAccounts(ctx);
  }
  return true;
}

// 扫码链路的状态同步：Go 是账号凭据唯一写者，Node 本地库只是运行池/桌面启动的
// 只读镜像；这里复用已有的对账入口，不引入新的轮询或第二份凭据源。
async function reconcileKimiAccounts(ctx) {
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.reconcileAccounts !== 'function') return;
  try {
    await goHost.reconcileAccounts();
  } catch (_error) {
    // 对账失败不能影响已经完成的扫码结果；下一轮同步/操作会再次收敛。
  }
}

// GET /v0/webui/accounts/kimi/:accountRef/plan-stats[?refresh=1]
async function handleKimiPlanStatsRequest(ctx) {
  const { pathname, url, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/plan-stats$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!requireAccountRouteScope(ctx, provider, 'plan-stats')) return true;
  const refresh = !!(url && url.searchParams && url.searchParams.get('refresh') === '1');
  return proxyGo(ctx, {
    method: 'getKimiPlanStats',
    args: [provider, accountRef, refresh],
    message: 'Go Core 未就绪，Kimi 套餐配额不可读',
    passStatuses: KIMI_GO_PASS_STATUSES
  });
}

// POST /v0/webui/accounts/:provider/:accountRef/open-app
//
// 契约、鉴权、Provider/账号校验、启动计划（kind/action/harness/transport/sessionKey）、
// 错误码与响应形状都在 Go（internal/transport/http/webuiopenappapi）。这里只做浏览器
// 前门：把路径参数与请求体转给 Go，Go 的领域结论原样透出（400/404/409/428/500/501）。
//
// 真正的宿主启动执行由 Go 通过回环内部端点调用（见 handleLaunchHostAppInternalRequest）：
// provider 桌面策略、账号出口与自动安装器都依赖 Node 宿主事实，不能搬到 HTTP 层。
async function handleOpenAccountAppRequest(ctx) {
  const { pathname, readRequestBody, writeJson } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/open-app$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : {}))
    .catch(() => null);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'openAccountApp',
    args: [parsed.provider, parsed.accountRef, payload],
    message: 'Go Core 未就绪，打开应用不可用',
    // 501 是「Go 已判定但宿主 Launcher 未接入」，必须带启动计划透出给界面。
    passStatuses: [400, 404, 409, 428, 500, 501]
  });
}

// 执行桥：POST /v0/internal/accounts/launch-app
//
// Go 已经完成 Provider/账号/计划判定，这里只按计划执行：
//   1. 组装账号应用启动器（资格、沙箱、Provider 路径与原生设置准备链）；
//   2. 解析账号出口并启动/关闭 Desktop 或 CLI；
//   3. 缺安装时回传安装目标与可用性，由 Go 翻译成 428。
// 内部端点只接受回环 + Go Core 引导密钥，浏览器与外部地址都进不来。
const INTERNAL_LAUNCH_PATH = '/v0/internal/accounts/launch-app';

function normalizeLaunchPlan(payload = {}) {
  return {
    provider: String(payload.provider || '').trim().toLowerCase(),
    accountRef: String(payload.accountRef || '').trim(),
    kind: String(payload.kind || '').trim().toLowerCase(),
    action: String(payload.action || 'open').trim().toLowerCase(),
    harness: String(payload.harness || '').trim().toLowerCase(),
    model: String(payload.model || '').trim(),
    terminalId: String(payload.terminalId || '').trim().toLowerCase(),
    workdir: String(payload.workdir || '').trim(),
    transport: String(payload.transport || '').trim().toLowerCase(),
    sessionKey: String(payload.sessionKey || '').trim()
  };
}

async function executeAccountAppLaunch(ctx, plan) {
  const { provider, accountRef, kind, action, harness, model, terminalId, workdir, transport, sessionKey } = plan;
  const routeDeps = ctx.deps || {};
  const launcher = createWebUiAccountAppLauncher(ctx, provider, accountRef, action);
  const launch = await launchAccountAppWithEgress({
    launcher,
    launchInput: { provider, accountRef, kind, action, terminalId, workdir, harness, model, transport, sessionKey },
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
      return {
        ok: false,
        error: result.error,
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
      };
    }
    return {
      ok: false,
      error: result.error,
      message: resolveAccountAppErrorMessage(result),
      ...(Array.isArray(result.pids) ? { pids: result.pids } : {}),
      ...(result.reason ? { reason: String(result.reason) } : {}),
      ...(result.requiredAction ? { requiredAction: result.requiredAction } : {}),
      ...(result.egressError ? { egressError: String(result.egressError) } : {}),
      ...(egressWarning ? { egressWarning } : {})
    };
  }
  return {
    ok: true,
    status: String(result.status || ''),
    pid: Number.isFinite(result.pid) ? result.pid : null,
    terminalId: String(result.terminalId || ''),
    sessionKey: String(result.sessionKey || sessionKey || ''),
    launchMode: String(result.launchMode || ''),
    executable: String(result.executable || ''),
    pids: Array.isArray(result.pids) ? result.pids : [],
    ...(egressWarning ? { egressWarning } : {})
  };
}

async function handleLaunchHostAppInternalRequest(ctx) {
  const pathname = String((ctx && ctx.pathname) || '');
  if (pathname !== INTERNAL_LAUNCH_PATH) return false;
  const { writeJson } = ctx;
  if (String((ctx && ctx.method) || '').toUpperCase() !== 'POST') {
    writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  if (!isDirectLoopbackRequest(ctx.req)) {
    writeJson(ctx.res, 403, { ok: false, error: 'launch_internal_loopback_required' });
    return true;
  }
  const goCoreKey = typeof (ctx.deps && ctx.deps.goCoreManagementKey) === 'function'
    ? String(ctx.deps.goCoreManagementKey() || '').trim()
    : '';
  const credential = parseBearerCredential(ctx.req);
  if (!goCoreKey || !credentialsEqual(credential, goCoreKey)) {
    writeJson(ctx.res, 401, { ok: false, error: 'launch_internal_unauthorized' });
    return true;
  }
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_launch_plan' });
    return true;
  }
  const plan = normalizeLaunchPlan(payload);
  if (!plan.provider || !plan.accountRef || !plan.kind || !plan.action) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_launch_plan' });
    return true;
  }
  try {
    const result = await executeAccountAppLaunch(ctx, plan);
    writeJson(ctx.res, 200, { ok: true, result });
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'launch_execute_failed',
      message: String((error && error.message) || error || 'unknown')
    });
  }
  return true;
}
// GET /v0/webui/app-entries - 宿主机实测的 Provider / 外部 harness 入口可用性，
// 并附带当前桌面与 CLI 运行中的账号清单。
//
// 探测（PATH / 安装落点 / .app bundle）、能力声明（含 crossProviderHarness 与外部
// harness）与运行态进程扫描都在 Go（internal/transport/http/webuiappentriesapi +
// internal/adapters/hostapps）。这里只做浏览器前门，Go 的结论（含 503）原样透出，
// 不再保留 Node 本地探测器兜底：同一响应不允许存在两套口径。
async function handleListAppEntriesRequest(ctx) {
  const refreshRequested = Boolean(ctx.url && typeof ctx.url.searchParams?.get === 'function'
    && ctx.url.searchParams.get('refresh') === '1');
  return proxyGo(ctx, {
    method: 'getAppEntries',
    args: [refreshRequested],
    message: 'Go Core 未就绪，入口可用性不可读'
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

function hasNonEmptyRoutingRules(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const rules = payload.upstreamErrorRules;
  const groupIds = payload.upstreamErrorGroupIds;
  return (Array.isArray(rules) && rules.length > 0)
    || (Array.isArray(groupIds) && groupIds.length > 0);
}

function writeGoUpdateFailure(ctx, response, fallbackError, fallbackMessage) {
  const status = Number(response && response.status) || 0;
  const data = response && response.data && typeof response.data === 'object' ? response.data : null;
  const code = String((data && (data.error || data.code)) || (response && response.errorCode) || '').trim();
  if (!response || status === 0 || code === 'go_core_unavailable' || code === 'network_error') {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 凭据编辑服务不可用'
    });
    return true;
  }
  if (data) {
    ctx.writeJson(ctx.res, status >= 400 ? status : 502, data);
    return true;
  }
  ctx.writeJson(ctx.res, status >= 400 ? status : 502, {
    ok: false,
    error: code || fallbackError,
    message: fallbackMessage
  });
  return true;
}

async function fetchGoLiveAccountRow(goHost, provider, goRef) {
  if (!goHost || typeof goHost.webuiRequest !== 'function') return null;
  const query = new URLSearchParams({ provider, ref: goRef }).toString();
  const res = await goHost.webuiRequest({
    method: 'GET',
    path: `/v1/management/webui/accounts/live?${query}`
  }).catch(() => null);
  const rows = res && res.ok === true && res.data && Array.isArray(res.data.accounts)
    ? res.data.accounts
    : null;
  return rows && rows[0] ? rows[0] : null;
}

async function handleUpdateAccountRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/update$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  let bodyInvalid = false;
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => {
      if (!buf || buf.length === 0) return {};
      const parsedJson = JSON.parse(buf.toString('utf8'));
      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        bodyInvalid = true;
        return null;
      }
      return parsedJson;
    })
    .catch(() => {
      bodyInvalid = true;
      return null;
    });
  if (bodyInvalid || !payload) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request', message: 'JSON 请求体无效' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }

  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost
    || typeof goHost.webuiRequest !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_required',
      message: '账号凭据编辑已切换到 Go Core，当前 Go Core 不可用。'
    });
    return true;
  }

  const hasBaseUrl = Object.prototype.hasOwnProperty.call(payload, 'baseUrl');
  const baseUrl = String(payload.baseUrl || '').trim();
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

  const apiKey = String(payload.apiKey || '').trim();
  const requestedCredentialType = String(
    payload.credentialType || payload.authType || payload.authMode || payload.authKind || ''
  ).trim();
  const hasRules = Object.prototype.hasOwnProperty.call(payload, 'upstreamErrorRules');
  const hasGroupIds = Object.prototype.hasOwnProperty.call(payload, 'upstreamErrorGroupIds');
  const clearErrorBlock = payload.clearErrorBlock === true;
  const hasNonEmptyRules = hasNonEmptyRoutingRules(payload);

  const goRef = (typeof goHost.goAccountRefFor === 'function'
    ? String(goHost.goAccountRefFor(accountRef) || '').trim()
    : '') || accountRef;

  let existingLiveRow = null;
  if ((hasRules !== hasGroupIds) || (!hasBaseUrl && hasNonEmptyRules)) {
    existingLiveRow = await fetchGoLiveAccountRow(goHost, provider, goRef);
  }
  if (hasNonEmptyRules) {
    const effectiveBaseUrl = hasBaseUrl ? baseUrl : String((existingLiveRow && existingLiveRow.baseUrl) || '').trim();
    const isApiKey = existingLiveRow ? Boolean(existingLiveRow.apiKeyMode) : true;
    if (isSelfRelayBaseUrl(provider, effectiveBaseUrl, ctx)) {
      writeSelfRelayAccountRejected(ctx, provider);
      return true;
    }
    if ((existingLiveRow || hasBaseUrl) && !isCustomUpstreamAccount({ provider, apiKeyMode: isApiKey, baseUrl: effectiveBaseUrl })) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'routing_rules_unsupported_upstream',
        code: isApiKey ? 'official_upstream_standard_errors' : 'oauth_account_standard_errors',
        message: isApiKey
          ? '该账号使用厂商官方地址，返回的是标准错误码，不需要自定义调度规则。'
          : '登录态账号使用厂商官方链路，返回的是标准错误码，不需要自定义调度规则。'
      });
      return true;
    }
  }

  const updateBody = {
    ...(apiKey ? { apiKey } : {}),
    ...(hasBaseUrl ? { baseUrl } : {}),
    ...(requestedCredentialType ? { authKind: requestedCredentialType, credentialType: requestedCredentialType } : {})
  };
  const updateRes = await goHost.webuiRequest({
    method: 'POST',
    path: `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(goRef)}/update`,
    body: updateBody
  }).catch(() => null);
  if (!updateRes || updateRes.ok !== true) {
    return writeGoUpdateFailure(ctx, updateRes, 'go_credential_edit_failed', 'Go Core 凭据编辑失败，账号未被修改。');
  }

  if (hasRules || hasGroupIds) {
    if (typeof goHost.updateAccountRoutingRules !== 'function') {
      writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 调度规则服务不可用' });
      return true;
    }
    const rulesPayload = {
      upstreamErrorRules: hasRules
        ? payload.upstreamErrorRules
        : (Array.isArray(existingLiveRow && existingLiveRow.upstreamErrorRules) ? existingLiveRow.upstreamErrorRules : []),
      upstreamErrorGroupIds: hasGroupIds
        ? payload.upstreamErrorGroupIds
        : (Array.isArray(existingLiveRow && existingLiveRow.upstreamErrorGroupIds) ? existingLiveRow.upstreamErrorGroupIds : []),
      ...(clearErrorBlock ? { clearErrorBlock: true } : {})
    };
    const rulesRes = await goHost.updateAccountRoutingRules(provider, accountRef, rulesPayload).catch(() => null);
    if (!rulesRes || rulesRes.ok !== true) {
      return writeGoUpdateFailure(ctx, rulesRes, 'invalid_routing_rules', 'Go Core 调度规则保存失败');
    }
  } else if (clearErrorBlock) {
    if (typeof goHost.restoreAccountScheduling !== 'function') {
      writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 调度恢复服务不可用' });
      return true;
    }
    const restoreRes = await goHost.restoreAccountScheduling(provider, accountRef).catch(() => null);
    if (!restoreRes || restoreRes.ok !== true) {
      return writeGoUpdateFailure(ctx, restoreRes, 'restore_scheduling_failed', 'Go Core 恢复调度失败');
    }
  }

  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}

  const credentialChanged = Boolean(apiKey || hasBaseUrl || requestedCredentialType);
  if (credentialChanged) invalidateModelCacheForAccountRefs(ctx, [accountRef]);
  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account });
  return true;
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
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost
    || typeof goHost.deleteAccount !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_required',
      message: '账号删除已切换到 Go Core，当前 Go Core 不可用。'
    });
    return true;
  }
  const forceRequested = isForceDeleteRequest(ctx);
  return handleGoDeleteAccountRequest(ctx, { provider, accountRef, forceRequested });
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

// 导出响应里直接透传给浏览器的头：附件字节与计数都由 Go 生成，Node 不重算。
const EXPORT_PASSTHROUGH_HEADERS = Object.freeze([
  'content-type',
  'content-disposition',
  'cache-control',
  'x-content-type-options',
  'x-aih-exported-accounts',
  'x-aih-skipped-accounts',
  'x-aih-node-only-accounts'
]);

// POST /v0/webui/accounts/import 的体积上限（与 Go 侧的 80MB 一致）。
const WEBUI_ACCOUNT_IMPORT_MAX_BYTES = 80 * 1024 * 1024;

// 账号导出的协议外壳：format 校验 + 转发 Go 生成的附件。
//
// Go 产出文档字节、Content-Disposition（单账号 / 单 Provider / 全部的旧命名规则）
// 与 X-AIH-* 计数头；Node 不再读本地凭据库算 node-only，也不重新序列化文档。
async function handleExportAccountsRequest(ctx) {
  const { deps, url, writeJson, res } = ctx;
  const format = String(url && url.searchParams && url.searchParams.get('format') || '').trim().toLowerCase();
  if (format && format !== 'aih' && format !== 'native') {
    writeJson(res, 400, { ok: false, error: 'unsupported_export_format' });
    return true;
  }
  const goHost = deps && deps.goCoreSync;
  if (!goHost
    || typeof goHost.exportAccountsDocument !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    writeJson(res, 503, { ok: false, error: 'go_core_required' });
    return true;
  }
  // 只转发 Go 认识的过滤键：format 是 WebUI 自己的协议位，Go 的过滤白名单
  // 不接受未知键（会把整次导出判成参数无效）。
  const params = new URLSearchParams();
  for (const name of ['provider', 'accountRef']) {
    for (const value of url.searchParams.getAll(name)) {
      const trimmed = String(value || '').trim();
      if (trimmed) params.append(name, trimmed);
    }
  }
  const exported = await goHost.exportAccountsDocument(params.toString());
  if (!exported || !exported.ok) {
    writeJson(res, exported && exported.status ? exported.status : 502, {
      ok: false,
      error: (exported && exported.errorCode) || 'go_export_failed'
    });
    return true;
  }
  const headers = {};
  for (const name of EXPORT_PASSTHROUGH_HEADERS) {
    const value = exported.headers && exported.headers[name];
    if (value) headers[name] = value;
  }
  res.writeHead(200, headers);
  res.end(exported.body);
  return true;
}

// GET /v0/webui/accounts/import/jobs/:jobId - 作业快照直接来自 Go。
async function handleGetImportJobRequest(ctx) {
  const { pathname, deps, writeJson } = ctx;
  const goHost = deps && deps.goCoreSync;
  if (!goHost
    || typeof goHost.getAccountImportJob !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_required' });
    return true;
  }
  const matches = pathname.match(/^\/v0\/webui\/accounts\/import\/jobs\/([^/]+)$/);
  const response = await goHost.getAccountImportJob(matches ? matches[1] : '');
  if (!response) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  writeJson(ctx.res, response.status || 502, response.data || { ok: false, error: 'job_not_found' });
  return true;
}

// POST /v0/webui/accounts/import - 创建 Go 的导入作业，Node 不再自己排队执行。
async function handleImportAccountsRequest(ctx) {
  const { deps, readRequestBody, writeJson } = ctx;
  const goHost = deps && deps.goCoreSync;
  if (!goHost
    || typeof goHost.startAccountImportJob !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_required' });
    return true;
  }
  // 体积上限留在协议层：超过 80MB 直接拒绝，不把后续内容读进内存。
  const body = await readRequestBody(ctx.req, { maxBytes: WEBUI_ACCOUNT_IMPORT_MAX_BYTES })
    .catch(() => null);
  if (!body || body.length === 0) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_import_data' });
    return true;
  }
  // JSON 合法性与文档解析都由 Go 判定（400 invalid_import_data）；Node 不再全量
  // JSON.parse 明文凭据负载，只转发原始字节。
  const started = await goHost.startAccountImportJob(body.toString('utf8'));
  if (!started) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  writeJson(ctx.res, started.status || 502, started.data || { ok: false, error: 'go_import_failed' });
  return true;
}


module.exports = {
  handleListAccountsRequest,
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
  handleLaunchHostAppInternalRequest,
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
