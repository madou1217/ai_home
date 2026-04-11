'use strict';
const path = require('node:path');
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
  extractCodexMetadata,
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
const {
  handleGetModelsRequest,
  handleGetProjectsRequest,
  handlePickProjectRequest,
  handleOpenProjectRequest,
  handleRemoveProjectRequest
} = require('./webui-project-routes');
const {
  handleGetAccountSessionsRequest,
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
  handleAddAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest
} = require('./webui-account-routes');

// 项目列表缓存（避免每次请求都扫描文件系统）
let _projectsCache = null;
let _projectsCacheTime = 0;
const PROJECTS_CACHE_TTL = 120000; // 120秒

// 后台自动刷新缓存
let _bgRefreshTimer = null;
let _authJobManager = null;

function startBackgroundRefresh() {
  if (_bgRefreshTimer) return;
  // 首次预热
  const warmupTimer = setTimeout(() => {
    try {
      const { readAllProjectsFromHost } = require('../sessions/session-reader');
      _projectsCache = readAllProjectsFromHost();
      _projectsCacheTime = Date.now();
    } catch (e) { /* ignore */ }
  }, 1000);
  if (warmupTimer && typeof warmupTimer.unref === 'function') {
    warmupTimer.unref();
  }
  // 定期刷新
  _bgRefreshTimer = setInterval(() => {
    try {
      const { readAllProjectsFromHost } = require('../sessions/session-reader');
      _projectsCache = readAllProjectsFromHost();
      _projectsCacheTime = Date.now();
    } catch (e) { /* ignore */ }
  }, PROJECTS_CACHE_TTL);
  if (_bgRefreshTimer && typeof _bgRefreshTimer.unref === 'function') {
    _bgRefreshTimer.unref();
  }
}
startBackgroundRefresh();

function getAuthJobManager(deps, state) {
  if (_authJobManager) return _authJobManager;
  _authJobManager = createAuthJobManager({
    fs: deps.fs,
    getToolAccountIds: deps.getToolAccountIds,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    onOauthJobFinished: async (job) => {
      if (!job || job.status !== 'succeeded') return;
      const profileDir = deps.getProfileDir(job.provider, job.accountId);
      const status = deps.checkStatus(job.provider, profileDir) || {};
      deps.accountStateIndex.upsertAccountState(job.provider, job.accountId, {
        configured: Boolean(status.configured),
        apiKeyMode: false,
        displayName: status.accountName && status.accountName !== 'Unknown'
          ? status.accountName
          : `${job.provider}-${job.accountId}`
      });
      const runtimeAccounts = deps.loadServerRuntimeAccounts({
        fs: deps.fs,
        getToolAccountIds: deps.getToolAccountIds,
        getToolConfigDir: deps.getToolConfigDir,
        getProfileDir: deps.getProfileDir,
        checkStatus: deps.checkStatus
      });
      deps.applyReloadState(state, runtimeAccounts);
    }
  });
  return _authJobManager;
}

function cleanupAuthJobArtifacts(job, deps, state) {
  if (!job) return;
  const { fs, accountStateIndex, loadServerRuntimeAccounts, getToolAccountIds, getToolConfigDir, getProfileDir, checkStatus, applyReloadState } = deps;
  if (job.profileDir && fs.existsSync(job.profileDir)) {
    try {
      fs.rmSync(job.profileDir, { recursive: true, force: true });
    } catch (_error) {
      // ignore best effort cleanup
    }
  }
  accountStateIndex.removeAccount(job.provider, job.accountId);
  try {
    const runtimeAccounts = loadServerRuntimeAccounts({
      fs,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus
    });
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
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    ensureSessionStoreLinks,
    pickProjectDirectory
  } = deps;
  const cacheState = {
    projects: _projectsCache,
    projectsAt: _projectsCacheTime,
    projectsTtlMs: PROJECTS_CACHE_TTL
  };
  const invalidateProjectsCache = () => {
    _projectsCache = null;
    _projectsCacheTime = 0;
    cacheState.projects = null;
    cacheState.projectsAt = 0;
  };
  const syncProjectsCache = () => {
    _projectsCache = cacheState.projects;
    _projectsCacheTime = cacheState.projectsAt;
  };
  const routeCtx = {
    ...ctx,
    fs,
    writeJson,
    readRequestBody,
    accountStateIndex,
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    ensureSessionStoreLinks,
    pickProjectDirectory,
    cacheState,
    invalidateProjectsCache,
    getAuthJobManager,
    cleanupAuthJobArtifacts,
    registerNativeChatRun,
    unregisterNativeChatRun,
    getNativeChatRun,
    createChatEventMeta,
    deps: {
      ...deps,
      fetchModelsForAccount: deps.fetchModelsForAccount
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

  // GET /v0/webui/models - 获取按 provider 分组的模型列表
  if (method === 'GET' && pathname === '/v0/webui/models') {
    const handled = await handleGetModelsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/slash-commands?provider=claude
  if (method === 'GET' && pathname === '/v0/webui/slash-commands') {
    const handled = await handleGetSlashCommandsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/chat/attachments?path=... - 读取聊天临时图片附件
  if (method === 'GET' && pathname === '/v0/webui/chat/attachments') {
    const handled = await handleGetChatAttachmentRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/accounts - 获取所有账号详细信息（包括状态）
  if (method === 'GET' && pathname === '/v0/webui/accounts') {
    const handled = await handleListAccountsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/accounts/add/jobs/:jobId - 查询 OAuth 添加账号作业状态
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/)) {
    const handled = await handleGetAddJobRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/accounts/add/jobs/:jobId/cancel - 取消 OAuth 添加作业
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/)) {
    const handled = await handleCancelAddJobRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/accounts/add - 添加新账号
  if (method === 'POST' && pathname === '/v0/webui/accounts/add') {
    const handled = await handleAddAccountRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // DELETE /v0/webui/accounts/:provider/:accountId - 删除账号
  if (method === 'DELETE' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/)) {
    const handled = await handleDeleteAccountRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/accounts/export - 导出账号配置
  if (method === 'GET' && pathname === '/v0/webui/accounts/export') {
    const handled = await handleExportAccountsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/accounts/import - 导入账号配置
  if (method === 'POST' && pathname === '/v0/webui/accounts/import') {
    const handled = await handleImportAccountsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/config - 获取全局配置
  if (method === 'GET' && pathname === '/v0/webui/config') {
    const handled = await handleGetUsageConfigRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/server-config - 获取 server 配置
  if (method === 'GET' && pathname === '/v0/webui/server-config') {
    const handled = await handleGetServerConfigRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/server-config - 更新 server 配置
  if (method === 'POST' && pathname === '/v0/webui/server-config') {
    const handled = await handleSetServerConfigRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/server/restart - 使用持久化配置重启 server
  if (method === 'POST' && pathname === '/v0/webui/server/restart') {
    const handled = await handleRestartServerRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/config - 更新全局配置
  if (method === 'POST' && pathname === '/v0/webui/config') {
    const handled = await handleSetUsageConfigRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/projects - 获取所有项目（从宿主 HOME 读取,按项目路径聚合）
  if (method === 'GET' && pathname === '/v0/webui/projects') {
    const handled = await handleGetProjectsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/projects/pick - 在服务端宿主机弹出目录选择器
  if (method === 'POST' && pathname === '/v0/webui/projects/pick') {
    const handled = await handlePickProjectRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/projects/open - 手动打开一个项目目录
  if (method === 'POST' && pathname === '/v0/webui/projects/open') {
    const handled = await handleOpenProjectRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/projects/remove - 移除手动打开的项目目录
  if (method === 'POST' && pathname === '/v0/webui/projects/remove') {
    const handled = await handleRemoveProjectRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:accountId - 获取账号的项目和会话数据
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/)) {
    const handled = await handleGetAccountSessionsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:sessionId/messages - 获取 session 的消息内容
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/)) {
    const handled = await handleGetSessionMessagesRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // GET /v0/webui/sessions/:provider/:sessionId/events - 获取 session 的增量事件
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/)) {
    const handled = await handleGetSessionEventsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/sessions/archive - 归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/archive') {
    const handled = await handleArchiveSessionRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }


  // GET /v0/webui/sessions/archived - 获取所有已归档的会话
  if (method === 'GET' && pathname === '/v0/webui/sessions/archived') {
    const handled = await handleGetArchivedSessionsRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/sessions/unarchive - 还原归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/unarchive') {
    const handled = await handleUnarchiveSessionRequest(routeCtx);
    syncProjectsCache();
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
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/chat/runs/:runId/resize - 调整运行中的 PTY 尺寸
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/resize$/)) {
    const handled = await handleNativeChatRunResizeRequest(routeCtx);
    syncProjectsCache();
    return handled;
  }

  // POST /v0/webui/chat - 发送聊天消息
  if (method === 'POST' && pathname === '/v0/webui/chat') {
    const handled = await handleChatRequest(routeCtx);
    syncProjectsCache();
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
  handleWebUIRequest
};
