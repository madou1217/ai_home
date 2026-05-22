'use strict';
const path = require('node:path');
const {
  readAccountStatusFile,
  writeAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../account/status-file');
const { withAccountQueryListFns } = require('./account-load-args');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  configureApiKeyAccount,
  createAuthJobManager,
  getNextAccountIdFromIds,
  isSupportedAuthMode,
  normalizeAuthMode
} = require('./web-account-auth');
const {
  readOpenedProjects,
  addOpenedProject
} = require('./webui-project-store');
const {
  normalizeCodexAuthPayload,
  readAccountExportRecord,
  parseManualImportText,
  inferImportProvider,
  buildRuntimeImportTools
} = require('./web-account-transfer');
const {
  appendImagePathsToPrompt,
  persistChatImages
} = require('./chat-attachments');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  getProviderSlashCommands,
  validateNativeSlashCommand
} = require('./native-slash-commands');
const {
  registerNativeChatRun,
  unregisterNativeChatRun,
  getNativeChatRun,
  createChatEventMeta
} = require('./native-chat-run-store');
const { handleWebUiSessionWatchRequest } = require('./webui-session-watch');
const { handleWebUiProjectsWatchRequest } = require('./webui-project-watch');
const {
  handleGetModelsRequest,
  handleGetProjectsRequest,
  handlePickProjectRequest,
  handleOpenProjectRequest,
  handleRemoveProjectRequest
} = require('./webui-project-routes');
const {
  handleReadFileRequest
} = require('./webui-file-routes');
const {
  handleGetSessionMessagesRequest,
  handleGetSessionEventsRequest,
  handleArchiveSessionRequest,
  handleGetArchivedSessionsRequest,
  handleUnarchiveSessionRequest
} = require('./webui-session-routes');
const {
  handleGetChatAttachmentRequest,
  handleGetSlashCommandsRequest,
  handleNativeChatRunInputRequest,
  handleNativeChatRunResizeRequest,
  handleChatRequest
} = require('./webui-chat-routes');
const {
  handleGetUsageConfigRequest,
  handleSetUsageConfigRequest,
  handleGetServerConfigRequest,
  handleSetServerConfigRequest,
  handleRestartServerRequest
} = require('./webui-config-routes');
const {
  handleListAccountsRequest,
  handleGetAddJobRequest,
  handleCancelAddJobRequest,
  handleCompleteAddJobCallbackRequest,
  handleAddAccountRequest,
  handleRefreshAccountUsageRequest,
  handleUpdateAccountStatusRequest,
  handleUpdateAccountRequest,
  handleSetDefaultAccountRequest,
  handleSetMobileAccountRequest,
  handleReauthAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest
} = require('./webui-account-routes');
const {
  handleAccountsWatchRequest,
  refreshLiveAccountRecord
} = require('./webui-account-live');
const { cleanOauthDisplayName } = require('./account-display-identity');
const { ensureProjectsSnapshotScheduler } = require('./webui-project-cache');
const { ensureArchivedSnapshotScheduler } = require('./webui-archived-cache');
const { handleWebUiModelAliasRoutes } = require('./webui-model-alias-routes');
let _authJobManager = null;

function appendOauthJobSyncLog(job, message) {
  if (!job || !message) return;
  const line = `[${new Date().toISOString()}] ${String(message).trim()}\n`;
  job.logs = `${String(job.logs || '')}${line}`;
  job.updatedAt = Date.now();
}

async function handleOauthJobFinishedStateSync(deps, state, job) {
  if (!job || job.status !== 'succeeded') return;
  const profileDir = deps.getProfileDir(job.provider, job.accountId);
  const status = deps.checkStatus(job.provider, profileDir) || {};
  appendOauthJobSyncLog(
    job,
    `状态同步：checkStatus configured=${Boolean(status.configured)} account=${cleanOauthDisplayName(status.accountName) || 'unknown'}`
  );
  const previousState = deps.accountStateIndex.getAccountState(job.provider, job.accountId) || null;
  const effectiveStatus = resolveEffectiveAccountStatus(
    previousState && previousState.status,
    readAccountStatusFile(deps.fs, profileDir)
  );
  const baseState = {
    status: effectiveStatus || 'up',
    configured: Boolean(status.configured),
    apiKeyMode: false,
    authMode: job.authMode,
    displayName: cleanOauthDisplayName(status.accountName) || cleanOauthDisplayName(job.displayName || job.email)
  };

  let targetAccountId = job.accountId;
  let targetProfileDir = profileDir;

  let duplicateId = null;
  if (baseState.displayName && typeof deps.getToolAccountIds === 'function' && deps.accountStateIndex) {
    const allIds = deps.getToolAccountIds(job.provider);
    for (const otherId of allIds) {
      if (String(otherId) === String(job.accountId)) continue;
      const otherState = deps.accountStateIndex.getAccountState(job.provider, otherId);
      if (otherState && String(otherState.display_name || '').trim() === baseState.displayName) {
        duplicateId = String(otherId);
        break;
      }
    }
  }

  const filesToMerge = [
    path.join('.codex', 'auth.json'),
    path.join('.claude', 'credentials.json'),
    path.join('.gemini', 'oauth_creds.json'),
    '.aih_env.json'
  ];

  if (duplicateId) {
    appendOauthJobSyncLog(job, `状态同步：发现已存在相同身份(${baseState.displayName})的账号 ${duplicateId}，执行自动合并与清理。`);
    const dupProfileDir = deps.getProfileDir(job.provider, duplicateId);

    for (const relPath of filesToMerge) {
      const srcFile = path.join(profileDir, relPath);
      const dstFile = path.join(dupProfileDir, relPath);
      if (deps.fs.existsSync(srcFile)) {
        deps.fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        deps.fs.copyFileSync(srcFile, dstFile);
      }
    }

    try {
      deps.fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_e) {}
    if (deps.accountStateService && typeof deps.accountStateService.deleteAccount === 'function') {
      deps.accountStateService.deleteAccount(job.provider, job.accountId);
    }

    if (job.reauth && String(job._reauthTargetId) !== duplicateId) {
      appendOauthJobSyncLog(job, `状态同步：你正试图为账号 ${job._reauthTargetId} 重新授权，但实际登录的身份匹配了账号 ${duplicateId}。新凭证已更新至 ${duplicateId}，${job._reauthTargetId} 保持原样不被污染，临时任务账号 ${job.accountId} 已销毁。`);
    } else {
      appendOauthJobSyncLog(job, `状态同步：新增产生的临时任务账号 ${job.accountId} 已被删除。`);
    }

    targetAccountId = duplicateId;
    targetProfileDir = dupProfileDir;
    job.accountId = duplicateId;
  } else if (job.reauth && job._reauthTargetId) {
    appendOauthJobSyncLog(job, `状态同步：重授权任务完成，新身份未发现重复，正在将临时任务账号 ${job.accountId} 的凭证合并至目标账号 ${job._reauthTargetId}。`);
    const targetReauthProfileDir = deps.getProfileDir(job.provider, job._reauthTargetId);

    for (const relPath of filesToMerge) {
      const srcFile = path.join(profileDir, relPath);
      const dstFile = path.join(targetReauthProfileDir, relPath);
      if (deps.fs.existsSync(srcFile)) {
        deps.fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        deps.fs.copyFileSync(srcFile, dstFile);
      }
    }

    try {
      deps.fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (_e) {}
    if (deps.accountStateService && typeof deps.accountStateService.deleteAccount === 'function') {
      deps.accountStateService.deleteAccount(job.provider, job.accountId);
    }

    targetAccountId = job._reauthTargetId;
    targetProfileDir = targetReauthProfileDir;
    job.accountId = job._reauthTargetId;
  }

  writeAccountStatusFile(deps.fs, targetProfileDir, baseState.status || 'up');
  if (deps.accountStateService && typeof deps.accountStateService.syncAccountBaseState === 'function') {
    deps.accountStateService.syncAccountBaseState(job.provider, targetAccountId, baseState);
  }
  if (deps.accountStateService && typeof deps.accountStateService.clearRuntimeBlock === 'function') {
    deps.accountStateService.clearRuntimeBlock(job.provider, targetAccountId, {
      ...baseState,
      evidence: 'login_success'
    });
  }
  if (deps.accountArtifactHooks && typeof deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated === 'function') {
    deps.accountArtifactHooks.notifyDefaultAccountAuthUpdated({
      provider: job.provider,
      accountId: targetAccountId,
      source: 'oauth_job_finished',
      reason: 'oauth_credentials_updated'
    });
  }
  const runtimeAccounts = deps.loadServerRuntimeAccounts(withAccountQueryListFns({
    fs: deps.fs,
    accountStateIndex: deps.accountStateIndex,
    getToolAccountIds: deps.getToolAccountIds,
    getToolConfigDir: deps.getToolConfigDir,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    serverPort: deps.options && deps.options.port
  }, deps));
  deps.applyReloadState(state, runtimeAccounts);
  const providerAccounts = Array.isArray(runtimeAccounts && runtimeAccounts[job.provider])
    ? runtimeAccounts[job.provider]
    : [];
  const inRuntimePool = providerAccounts.some((account) => String(account && account.id || account && account.accountId || '') === String(job.accountId));
  appendOauthJobSyncLog(job, `状态同步：runtime reload 完成，账号${inRuntimePool ? '已进入' : '未进入'} ${job.provider} runtime pool。`);
  if (typeof deps.ensureUsageSnapshotAsync === 'function') {
    setTimeout(() => {
      refreshLiveAccountRecord({
        state,
        fs: deps.fs,
        aiHomeDir: deps.aiHomeDir,
        accountStateIndex: deps.accountStateIndex,
        getToolAccountIds: deps.getToolAccountIds,
        getToolConfigDir: deps.getToolConfigDir,
        getProfileDir: deps.getProfileDir,
        checkStatus: deps.checkStatus,
        getLastUsageProbeError: deps.getLastUsageProbeError,
        getLastUsageProbeState: deps.getLastUsageProbeState,
        ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
        loadServerRuntimeAccounts: deps.loadServerRuntimeAccounts,
        applyReloadState: deps.applyReloadState
      }, job.provider, job.accountId).catch(() => {});
    }, 0);
  }
}

function getAuthJobManager(deps, state) {
  if (_authJobManager) return _authJobManager;
  _authJobManager = createAuthJobManager({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    verifyOauthJobCompleted: async (job) => {
      if (!job || job.provider !== 'codex') return { ok: true };
      const profileDir = deps.getProfileDir(job.provider, job.accountId);
      const status = deps.checkStatus(job.provider, profileDir) || {};
      const displayName = cleanOauthDisplayName(status.accountName);
      if (!status.configured) {
        return {
          ok: false,
          code: 'oauth_artifact_not_configured',
          message: 'auth.json 已写入，但账号状态检测仍为未配置'
        };
      }
      return {
        ok: true,
        displayName,
        email: displayName
      };
    },
    onOauthJobFinished: async (job) => handleOauthJobFinishedStateSync(deps, state, job)
  });
  return _authJobManager;
}

function cleanupAuthJobArtifacts(job, deps, state) {
  if (!job) return;
  const { fs, accountStateIndex, accountStateService, loadServerRuntimeAccounts, getToolAccountIds, getToolConfigDir, getProfileDir, checkStatus, applyReloadState } = deps;
  const preserveExistingAccount = Boolean(job._preserveExistingAccount || job.reauth);
  if (!preserveExistingAccount && job.profileDir && fs.existsSync(job.profileDir)) {
    try {
      fs.rmSync(job.profileDir, { recursive: true, force: true });
    } catch (_error) {
      // ignore best effort cleanup
    }
  }
  if (!preserveExistingAccount) {
    if (accountStateService && typeof accountStateService.deleteAccount === 'function') {
      accountStateService.deleteAccount(job.provider, job.accountId);
    }
  }
  try {
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      serverPort: deps.options && deps.options.port
    }, deps));
    applyReloadState(state, runtimeAccounts);
  } catch (_error) {
    // partial cleanup is acceptable
  }
}

/**
 * Web UI 路由处理器
 * 提供静态文件服务和额外的 Web UI API
 */
async function handleWebUIRequest(ctx) {
  const {
    method,
    pathname,
    url,
    req,
    res,
    options,
    state,
    deps
  } = ctx;

  const {
    fs,
    writeJson,
    readRequestBody,
    accountStateIndex,
    accountStateService,
    accountQueryService,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    ensureSessionStoreLinks,
    pickProjectDirectory,
    aiHomeDir,
    syncGlobalConfigToHost,
    accountArtifactHooks
  } = deps;
  ensureProjectsSnapshotScheduler({
    state,
    fs,
    aiHomeDir
  });
  ensureArchivedSnapshotScheduler({
    state,
    fs,
    aiHomeDir
  });
  const routeCtx = {
    ...ctx,
    fs,
    writeJson,
    readRequestBody,
    accountStateIndex,
    accountStateService,
    accountQueryService,
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    ensureSessionStoreLinks,
    pickProjectDirectory,
    aiHomeDir,
    getAuthJobManager,
    cleanupAuthJobArtifacts,
    registerNativeChatRun,
    unregisterNativeChatRun,
    getNativeChatRun,
    createChatEventMeta,
    deps: {
      ...deps,
      accountStateService,
      accountQueryService,
      fetchModelsForAccount: deps.fetchModelsForAccount,
      syncGlobalConfigToHost,
      accountArtifactHooks
    }
  };

  // /ui -> /ui/ 重定向
  if (pathname === '/ui') {
    res.writeHead(302, { Location: '/ui/' });
    res.end();
    return true;
  }

  // 静态文件服务
  if (pathname.startsWith('/ui/')) {
    return serveStaticFile(pathname, res, { fs, options });
  }

  // Web UI API 路由
  if (!pathname.startsWith('/v0/webui')) return false;

  if (pathname === '/v0/webui/model-aliases' || pathname.startsWith('/v0/webui/model-aliases/')) {
    const handled = await handleWebUiModelAliasRoutes(routeCtx);
    if (handled) return true;
  }

  // GET /v0/webui/models - 获取按 provider 分组的模型列表
  if (method === 'GET' && pathname === '/v0/webui/models') {
    const handled = await handleGetModelsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/slash-commands?provider=claude
  if (method === 'GET' && pathname === '/v0/webui/slash-commands') {
    const handled = await handleGetSlashCommandsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/chat/attachments?path=... - 读取聊天临时图片附件
  if (method === 'GET' && pathname === '/v0/webui/chat/attachments') {
    const handled = await handleGetChatAttachmentRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/accounts - 获取所有账号详细信息（包括状态）
  if (method === 'GET' && pathname === '/v0/webui/accounts') {
    const handled = await handleListAccountsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/accounts/watch - SSE 监听账号列表增量更新
  if (method === 'GET' && pathname === '/v0/webui/accounts/watch') {
    return handleAccountsWatchRequest(routeCtx);
  }

  // GET /v0/webui/accounts/add/jobs/:jobId - 查询 OAuth 添加账号作业状态
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/)) {
    const handled = await handleGetAddJobRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/add/jobs/:jobId/cancel - 取消 OAuth 添加作业
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/)) {
    const handled = await handleCancelAddJobRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/add/jobs/:jobId/callback - 提交浏览器 OAuth 回调并由服务端换 token
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/callback$/)) {
    const handled = await handleCompleteAddJobCallbackRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/add - 添加新账号
  if (method === 'POST' && pathname === '/v0/webui/accounts/add') {
    const handled = await handleAddAccountRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/refresh-usage - 刷新指定账号额度状态
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh-usage$/)) {
    const handled = await handleRefreshAccountUsageRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/status - 更新账号启用状态
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/status$/)) {
    const handled = await handleUpdateAccountStatusRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/update - 更新账号配置 (URL, API Key)
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/update$/)) {
    const handled = await handleUpdateAccountRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/set-default - 设置真实会话默认账号
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-default$/)) {
    const handled = await handleSetDefaultAccountRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/set-mobile - 设置 Codex App 账号
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-mobile$/)) {
    const handled = await handleSetMobileAccountRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/:provider/:accountId/reauth - 对认证失效账号按原方式重新认证
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/reauth$/)) {
    const handled = await handleReauthAccountRequest(routeCtx);
    return handled;
  }

  // DELETE /v0/webui/accounts/:provider/:accountId - 删除账号
  if (method === 'DELETE' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/)) {
    const handled = await handleDeleteAccountRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/accounts/export - 导出账号配置
  if (method === 'GET' && pathname === '/v0/webui/accounts/export') {
    const handled = await handleExportAccountsRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/accounts/import - 导入账号配置
  if (method === 'POST' && pathname === '/v0/webui/accounts/import') {
    const handled = await handleImportAccountsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/config - 获取全局配置
  if (method === 'GET' && pathname === '/v0/webui/config') {
    const handled = await handleGetUsageConfigRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/server-config - 获取 server 配置
  if (method === 'GET' && pathname === '/v0/webui/server-config') {
    const handled = await handleGetServerConfigRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/server-config - 更新 server 配置
  if (method === 'POST' && pathname === '/v0/webui/server-config') {
    const handled = await handleSetServerConfigRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/server/restart - 使用持久化配置重启 server
  if (method === 'POST' && pathname === '/v0/webui/server/restart') {
    const handled = await handleRestartServerRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/config - 更新全局配置
  if (method === 'POST' && pathname === '/v0/webui/config') {
    const handled = await handleSetUsageConfigRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/projects - 获取所有项目（从宿主 HOME 读取,按项目路径聚合）
  if (method === 'GET' && pathname === '/v0/webui/projects') {
    const handled = await handleGetProjectsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/projects/watch - 单路 SSE 监听项目级运行态
  if (method === 'GET' && pathname === '/v0/webui/projects/watch') {
    return handleWebUiProjectsWatchRequest(routeCtx);
  }

  // POST /v0/webui/projects/pick - 在服务端宿主机弹出目录选择器
  if (method === 'POST' && pathname === '/v0/webui/projects/pick') {
    const handled = await handlePickProjectRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/projects/open - 手动打开一个项目目录
  if (method === 'POST' && pathname === '/v0/webui/projects/open') {
    const handled = await handleOpenProjectRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/projects/remove - 移除手动打开的项目目录
  if (method === 'POST' && pathname === '/v0/webui/projects/remove') {
    const handled = await handleRemoveProjectRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/fs/read - Securely read local file contents
  if (method === 'GET' && pathname === '/v0/webui/fs/read') {
    const handled = await handleReadFileRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:accountId - 获取账号的项目和会话数据
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/)) {
    const handled = await handleGetAccountSessionsRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:sessionId/messages - 获取 session 的消息内容
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/)) {
    const handled = await handleGetSessionMessagesRequest(routeCtx);
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:sessionId/events - 获取 session 的增量事件
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/)) {
    const handled = await handleGetSessionEventsRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/sessions/archive - 归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/archive') {
    const handled = await handleArchiveSessionRequest(routeCtx);
    return handled;
  }


  // GET /v0/webui/sessions/archived - 获取所有已归档的会话
  if (method === 'GET' && pathname === '/v0/webui/sessions/archived') {
    const handled = await handleGetArchivedSessionsRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/sessions/unarchive - 还原归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/unarchive') {
    const handled = await handleUnarchiveSessionRequest(routeCtx);
    return handled;
  }


  // GET /v0/webui/sessions/watch - SSE 监听会话文件变更
  if (method === 'GET' && pathname === '/v0/webui/sessions/watch') {
    return handleWebUiSessionWatchRequest({
      url,
      req,
      res,
      fs,
      writeJson
    });
  }

  // POST /v0/webui/chat/runs/:runId/input - 向运行中的原生会话写入输入
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/input$/)) {
    const handled = await handleNativeChatRunInputRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/chat/runs/:runId/resize - 调整运行中的 PTY 尺寸
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/resize$/)) {
    const handled = await handleNativeChatRunResizeRequest(routeCtx);
    return handled;
  }

  // POST /v0/webui/chat - 发送聊天消息
  if (method === 'POST' && pathname === '/v0/webui/chat') {
    const handled = await handleChatRequest(routeCtx);
    return handled;
  }

  writeJson(res, 404, { ok: false, error: 'webui_not_found' });
  return true;
}

/**
 * 提供静态文件服务（支持热更新，无缓存）
 */
function serveStaticFile(pathname, res, { fs, options }) {
  const webDir = path.join(__dirname, '../../web/dist');

  // 安全检查：防止目录遍历
  const normalizedPath = path.normalize(pathname.replace(/^\/ui/, ''));
  if (normalizedPath.includes('..')) {
    res.statusCode = 403;
    res.end('Forbidden');
    return true;
  }

  let filePath = path.join(webDir, normalizedPath);

  // 如果请求的是目录，返回 index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    // SPA fallback: 返回 index.html
    filePath = path.join(webDir, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end('Web UI not built. Run: cd web && npm run build');
      return true;
    }
  }

  // 设置 Content-Type
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject'
  };
  const contentType = contentTypeMap[ext] || 'application/octet-stream';

  try {
    // 每次都重新读取文件，支持热更新
    const content = fs.readFileSync(filePath);

    // 设置无缓存 headers，确保浏览器总是获取最新文件
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(content);
    return true;
  } catch (error) {
    res.statusCode = 500;
    res.end('Internal Server Error');
    return true;
  }
}

module.exports = {
  handleWebUIRequest,
  handleOauthJobFinishedStateSync
};
