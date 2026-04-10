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
  setTimeout(() => {
    try {
      const { readAllProjectsFromHost } = require('../sessions/session-reader');
      _projectsCache = readAllProjectsFromHost();
      _projectsCacheTime = Date.now();
    } catch (e) { /* ignore */ }
  }, 1000);
  // 定期刷新
  _bgRefreshTimer = setInterval(() => {
    try {
      const { readAllProjectsFromHost } = require('../sessions/session-reader');
      _projectsCache = readAllProjectsFromHost();
      _projectsCacheTime = Date.now();
    } catch (e) { /* ignore */ }
  }, PROJECTS_CACHE_TTL);
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
    checkStatus
  } = deps;

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
    try {
      const registry = state && state.modelRegistry;
      const result = {};

      // 1. 从 registry 获取（按 provider 分组）
      if (registry && registry.providers) {
        for (const [provider, models] of Object.entries(registry.providers)) {
          if (models instanceof Set && models.size > 0) {
            result[provider] = Array.from(models).sort();
          }
        }
      }

      // 2. 如果 registry 为空，通过 loopback 调自己的 /v1/models
      if (Object.keys(result).length === 0) {
        try {
          const port = options && options.port || 3456;
          const { fetchWithTimeout } = require('./http-utils');
          const resp = await fetchWithTimeout(
            `http://127.0.0.1:${port}/v1/models`,
            { method: 'GET', headers: { authorization: 'Bearer webui-internal' } },
            8000
          );
          if (resp.ok) {
            const data = await resp.json();
            const allModels = (data && data.data) || [];
            // 按 owned_by 或模型名前缀分组
            for (const m of allModels) {
              const id = m.id || '';
              let provider = 'codex'; // default
              if (id.startsWith('claude-') || id.startsWith('anthropic')) provider = 'claude';
              else if (id.startsWith('gemini-')) provider = 'gemini';
              if (!result[provider]) result[provider] = [];
              result[provider].push(id);
            }
            // 排序
            for (const p of Object.keys(result)) {
              result[p] = result[p].sort();
            }
          }
        } catch (e) { /* loopback failed */ }
      }

      writeJson(res, 200, { ok: true, models: result });
      return true;
    } catch (error) {
      writeJson(res, 500, { ok: false, error: 'get_models_failed' });
      return true;
    }
  }

  // GET /v0/webui/accounts - 获取所有账号详细信息（包括状态）
  if (method === 'GET' && pathname === '/v0/webui/accounts') {
    const accounts = [];

    for (const provider of SUPPORTED_SERVER_PROVIDERS) {
      const accountIds = getToolAccountIds(provider);
      for (const accountId of accountIds) {
        const configDir = getToolConfigDir(provider, accountId);
        const profileDir = getProfileDir(provider, accountId);

        // 获取状态信息
        const stateInfo = accountStateIndex.getAccountState(provider, accountId) || {};

        // 获取配置信息
        const configured = stateInfo.configured || false;
        const apiKeyMode = stateInfo.api_key_mode || false;

        // 检测账号计划类型（free/plus/team/business）
        let planType = apiKeyMode ? 'api-key' : '';
        let email = stateInfo.email || '';
        try {
          if (provider === 'codex' && !apiKeyMode) {
            const authPath = path.join(configDir, 'auth.json');
            if (fs.existsSync(authPath)) {
              const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
              if (authData.tokens && authData.tokens.id_token) {
                const parts = authData.tokens.id_token.split('.');
                if (parts.length >= 2) {
                  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
                  const authClaim = payload['https://api.openai.com/auth'] || {};
                  planType = authClaim.chatgpt_plan_type || 'free';
                  if (!email) email = payload.email || '';
                }
              }
            }
          } else if (provider === 'gemini') {
            // Gemini: 通过 auth type 判断
            const geminiDir = path.join(profileDir, '.gemini');
            const settingsPath = path.join(geminiDir, 'settings.json');
            if (fs.existsSync(settingsPath)) {
              const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
              const authType = settings?.security?.auth?.selectedType || '';
              planType = authType || 'oauth';
            }
          } else if (provider === 'claude') {
            planType = apiKeyMode ? 'api-key' : 'oauth';
          }
        } catch (e) { /* ignore */ }

        accounts.push({
          provider,
          accountId,
          displayName: stateInfo.display_name || `${provider}-${accountId}`,
          configured,
          apiKeyMode,
          exhausted: stateInfo.exhausted || false,
          remainingPct: stateInfo.remaining_pct || 0,
          updatedAt: stateInfo.updated_at || 0,
          planType,
          email,
          configDir,
          profileDir
        });
      }
    }

    writeJson(res, 200, { ok: true, accounts });
    return true;
  }

  // GET /v0/webui/accounts/add/jobs/:jobId - 查询 OAuth 添加账号作业状态
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/)) {
    const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/);
    const jobId = matches[1];
    const manager = getAuthJobManager(deps, state);
    const job = manager.getJob(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, error: 'job_not_found' });
      return true;
    }
    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        provider: job.provider,
        accountId: job.accountId,
        authMode: job.authMode,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        lastOutputAt: job.lastOutputAt,
        expiresAt: job.expiresAt,
        pollIntervalMs: job.pollIntervalMs,
        pid: job.pid,
        exitCode: job.exitCode,
        verificationUri: job.verificationUri,
        verificationUriComplete: job.verificationUriComplete,
        userCode: job.userCode,
        logs: job.logs,
        error: job.error
      }
    });
    return true;
  }

  // POST /v0/webui/accounts/add/jobs/:jobId/cancel - 取消 OAuth 添加作业
  if (method === 'POST' && pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/)) {
    const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/);
    const jobId = matches[1];
    const manager = getAuthJobManager(deps, state);
    const result = manager.cancelJob(jobId);
    if (!result.ok) {
      writeJson(res, 404, { ok: false, error: result.code || 'job_not_found' });
      return true;
    }

    const job = result.job;
    cleanupAuthJobArtifacts(job, deps, state);

    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        provider: job.provider,
        accountId: job.accountId,
        authMode: job.authMode,
        status: job.status,
        error: job.error,
        updatedAt: job.updatedAt
      }
    });
    return true;
  }

  // POST /v0/webui/accounts/add - 添加新账号
  if (method === 'POST' && pathname === '/v0/webui/accounts/add') {
    const payload = await readRequestBody(req, { maxBytes: 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.provider) {
      writeJson(res, 400, { ok: false, error: 'invalid_payload' });
      return true;
    }

    const provider = String(payload.provider || '').trim().toLowerCase();
    const authMode = normalizeAuthMode(payload.authMode || (payload.config && payload.config.apiKey ? 'api-key' : 'oauth-browser'));
    const config = payload.config || {};
    const replaceExisting = Boolean(payload.replaceExisting);

    if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
      writeJson(res, 400, { ok: false, error: 'unsupported_provider' });
      return true;
    }
    if (!authMode) {
      writeJson(res, 400, { ok: false, error: 'invalid_auth_mode' });
      return true;
    }
    if (!isSupportedAuthMode(provider, authMode)) {
      writeJson(res, 400, { ok: false, error: 'unsupported_auth_mode' });
      return true;
    }

    try {
      if (authMode === 'api-key') {
        const accountId = getNextAccountIdFromIds(getToolAccountIds(provider));
        configureApiKeyAccount({
          fs,
          provider,
          accountId,
          config,
          getProfileDir,
          getToolConfigDir
        });

        accountStateIndex.upsertAccountState(provider, accountId, {
          configured: true,
          apiKeyMode: true,
          displayName: `${provider}-${accountId}`
        });

        const runtimeAccounts = loadServerRuntimeAccounts({
          fs,
          getToolAccountIds,
          getToolConfigDir,
          getProfileDir,
          checkStatus
        });
        applyReloadState(state, runtimeAccounts);

        writeJson(res, 200, {
          ok: true,
          provider,
          accountId,
          authMode: 'api-key',
          status: 'configured'
        });
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
      const started = manager.startOauthJob(provider, authMode);

      accountStateIndex.upsertAccountState(provider, started.accountId, {
        configured: false,
        apiKeyMode: false,
        displayName: `${provider}-${started.accountId}`
      });

      writeJson(res, 200, {
        ok: true,
        provider,
        accountId: started.accountId,
        authMode,
        status: 'pending',
        jobId: started.jobId,
        expiresAt: Number.isFinite(started.expiresAt) ? started.expiresAt : null,
        pollIntervalMs: Number.isFinite(started.pollIntervalMs) ? started.pollIntervalMs : null
      });
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
      ) ? 400 : (code === 'oauth_job_already_running' ? 409 : 500);
      const response = { ok: false, error: 'add_account_failed', code, message: msg };
      if (code === 'oauth_job_already_running') {
        const manager = getAuthJobManager(deps, state);
        const activeJob = manager.getRunningJob(provider);
        response.jobId = String((error && error.jobId) || (activeJob && activeJob.id) || '');
        response.accountId = String((activeJob && activeJob.accountId) || '');
      }
      writeJson(res, statusCode, response);
      return true;
    }
  }

  // DELETE /v0/webui/accounts/:provider/:accountId - 删除账号
  if (method === 'DELETE' && pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/)) {
    const matches = pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/);
    const provider = matches[1];
    const accountId = matches[2];

    try {
      // 删除账号目录
      const profileDir = getProfileDir(provider, accountId);
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }

      // 同时删除 config 目录
      const configDir = getToolConfigDir(provider, accountId);
      if (configDir && fs.existsSync(configDir)) {
        fs.rmSync(configDir, { recursive: true, force: true });
      }

      // 从状态索引中移除
      accountStateIndex.removeAccount(provider, accountId);

      // 重新加载账号
      try {
        const runtimeAccounts = loadServerRuntimeAccounts({
          fs,
          getToolAccountIds,
          listUsageCandidateIds: () => [],
          listConfiguredIds: () => [],
          getToolConfigDir,
          getProfileDir,
          checkStatus,
          aiHomeDir: deps.aiHomeDir || ''
        });
        applyReloadState(state, runtimeAccounts);
      } catch (e) { /* partial reload ok */ }

      writeJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'delete_account_failed', message: msg });
      return true;
    }
  }

  // GET /v0/webui/accounts/export - 导出账号配置
  if (method === 'GET' && pathname === '/v0/webui/accounts/export') {
    try {
      const exportData = { version: 1, accounts: [], exportedAt: new Date().toISOString() };

      for (const provider of SUPPORTED_SERVER_PROVIDERS) {
        const accountIds = getToolAccountIds(provider);
        for (const id of accountIds) {
          const profileDir = getProfileDir(provider, id);
          const configDir = getToolConfigDir(provider, id);

          // 读取 auth 配置（脱敏处理）
          const account = { provider, accountId: id, auth: {}, config: {} };

          // 根据 provider 读取认证信息
          if (provider === 'codex') {
            const authPath = path.join(configDir, 'auth.json');
            if (fs.existsSync(authPath)) {
              account.auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            }
          } else if (provider === 'gemini') {
            const oauthPath = path.join(profileDir, '.gemini', 'oauth_creds.json');
            if (fs.existsSync(oauthPath)) {
              account.auth = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
            }
          } else if (provider === 'claude') {
            const credPath = path.join(profileDir, '.claude', '.credentials.json');
            if (fs.existsSync(credPath)) {
              account.auth = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            }
          }

          // 读取环境变量配置
          const envPath = path.join(profileDir, '.aih_env.json');
          if (fs.existsSync(envPath)) {
            account.config = JSON.parse(fs.readFileSync(envPath, 'utf8'));
          }

          exportData.accounts.push(account);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="ai-home-accounts.json"'
      });
      res.end(JSON.stringify(exportData, null, 2));
      return true;
    } catch (error) {
      writeJson(res, 500, { ok: false, error: 'export_failed' });
      return true;
    }
  }

  // POST /v0/webui/accounts/import - 导入账号配置
  if (method === 'POST' && pathname === '/v0/webui/accounts/import') {
    const payload = await readRequestBody(req, { maxBytes: 10 * 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !Array.isArray(payload.accounts)) {
      writeJson(res, 400, { ok: false, error: 'invalid_import_data' });
      return true;
    }

    try {
      let imported = 0;
      for (const account of payload.accounts) {
        const { provider, accountId, auth, config } = account;
        if (!provider || !accountId) continue;

        const profileDir = getProfileDir(provider, accountId);
        const configDir = getToolConfigDir(provider, accountId);

        // 创建目录
        fs.mkdirpSync(profileDir);
        fs.mkdirpSync(configDir);

        // 写入 auth
        if (auth && Object.keys(auth).length > 0) {
          if (provider === 'codex') {
            fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(auth, null, 2));
          } else if (provider === 'gemini') {
            const geminiDir = path.join(profileDir, '.gemini');
            fs.mkdirpSync(geminiDir);
            fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(auth, null, 2));
          } else if (provider === 'claude') {
            const claudeDir = path.join(profileDir, '.claude');
            fs.mkdirpSync(claudeDir);
            fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify(auth, null, 2));
          }
        }

        // 写入环境变量
        if (config && Object.keys(config).length > 0) {
          fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
        }

        imported++;
      }

      // 重新加载
      try {
        const runtimeAccounts = loadServerRuntimeAccounts({
          fs, getToolAccountIds, listUsageCandidateIds: () => [], listConfiguredIds: () => [],
          getToolConfigDir, getProfileDir, checkStatus, aiHomeDir: deps.aiHomeDir || ''
        });
        applyReloadState(state, runtimeAccounts);
      } catch (e) { /* ok */ }

      writeJson(res, 200, { ok: true, imported });
      return true;
    } catch (error) {
      writeJson(res, 500, { ok: false, error: 'import_failed' });
      return true;
    }
  }

  // GET /v0/webui/config - 获取全局配置
  if (method === 'GET' && pathname === '/v0/webui/config') {
    try {
      const { getUsageConfig } = require('../usage/config-store');
      const { aiHomeDir } = deps;
      const config = getUsageConfig({ fs, aiHomeDir });

      writeJson(res, 200, { ok: true, config });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'get_config_failed', message: msg });
      return true;
    }
  }

  // POST /v0/webui/config - 更新全局配置
  if (method === 'POST' && pathname === '/v0/webui/config') {
    const payload = await readRequestBody(req, { maxBytes: 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.config) {
      writeJson(res, 400, { ok: false, error: 'invalid_payload' });
      return true;
    }

    try {
      const { setUsageConfig } = require('../usage/config-store');
      const { aiHomeDir } = deps;
      setUsageConfig({ fs, aiHomeDir }, payload.config);

      writeJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'set_config_failed', message: msg });
      return true;
    }
  }

  // GET /v0/webui/projects - 获取所有项目（从宿主 HOME 读取,按项目路径聚合）
  if (method === 'GET' && pathname === '/v0/webui/projects') {
    try {
      const { readAllProjectsFromHost } = require('../sessions/session-reader');
      const now = Date.now();
      const forceRefresh = url.searchParams?.get('refresh') === '1' || (url.search && url.search.includes('refresh=1'));

      let allProjects;
      if (!forceRefresh && _projectsCache && (now - _projectsCacheTime) < PROJECTS_CACHE_TTL) {
        allProjects = _projectsCache;
      } else {
        allProjects = readAllProjectsFromHost();
        _projectsCache = allProjects;
        _projectsCacheTime = now;
      }

      // 按规范化路径聚合（同一目录不同 provider 的项目合并）
      // 规范化：去掉末尾斜线，统一为小写以防大小写差异
      const projectMap = new Map();

      function normalizePath(p) {
        return (p || '').replace(/\/+$/, '');
      }

      for (const project of allProjects) {
        const key = normalizePath(project.path);

        if (!projectMap.has(key)) {
          projectMap.set(key, {
            id: project.id,
            name: project.name,
            path: project.path,
            providers: [project.provider],
            sessions: []
          });
        } else {
          const existingProject = projectMap.get(key);
          if (!existingProject.providers.includes(project.provider)) {
            existingProject.providers.push(project.provider);
          }
        }

        // 聚合会话（标记 provider），同时记录 projectDirName 供 Claude 读取消息用
        const projectData = projectMap.get(key);
        for (const session of project.sessions) {
          projectData.sessions.push({
            ...session,
            provider: project.provider,
            projectDirName: session.projectDirName || project.id
          });
        }
      }

      // 转换为数组，过滤空项目，按更新时间排序会话
      const projects = Array.from(projectMap.values())
        .filter(p => p.sessions.length > 0) // 跳过没有会话的项目
        .map(p => ({
          ...p,
          sessions: p.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        }));

      writeJson(res, 200, { ok: true, projects });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'get_projects_failed', message: msg });
      return true;
    }
  }

  // GET /v0/webui/sessions/:provider/:accountId - 获取账号的项目和会话数据
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/)) {
    const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/);
    const provider = matches[1];
    const accountId = matches[2];

    try {
      const { readAccountSessions } = require('../sessions/session-reader');
      const profileDir = getProfileDir(provider, accountId);

      const projects = readAccountSessions(provider, profileDir);

      writeJson(res, 200, { ok: true, projects });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'get_sessions_failed', message: msg });
      return true;
    }
  }

  // GET /v0/webui/sessions/:provider/:sessionId/messages - 获取 session 的消息内容
  if (method === 'GET' && pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/)) {
    const matches = pathname.match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/);
    const provider = matches[1];
    const sessionId = matches[2];

    try {
      const { readSessionMessages } = require('../sessions/session-reader');

      // 从查询参数获取 projectDirName (仅 Claude 需要)
      const url = new URL(req.url, `http://${req.headers.host}`);
      const projectDirName = url.searchParams.get('projectDirName');

      const messages = readSessionMessages(provider, {
        sessionId,
        projectDirName
      });

      writeJson(res, 200, { ok: true, messages });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'get_messages_failed', message: msg });
      return true;
    }
  }

  // POST /v0/webui/sessions/archive - 归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/archive') {
    const payload = await readRequestBody(req, { maxBytes: 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.provider || !payload.sessionId) {
      writeJson(res, 400, { ok: false, error: 'missing_params' });
      return true;
    }

    try {
      const { provider, sessionId, projectDirName } = payload;
      const { getRealHome } = require('../sessions/session-reader');
      const hostHome = getRealHome();

      if (provider === 'codex') {
        // Codex 原生归档: 移动到 ~/.codex/archived_sessions/
        const sessionsDir = path.join(hostHome, '.codex', 'sessions');
        const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
        if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });

        const findFile = (dir) => {
          try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) {
                const r = findFile(fp);
                if (r) return r;
              } else if (e.name.includes(sessionId) && e.name.endsWith('.jsonl')) {
                return fp;
              }
            }
          } catch (e) {}
          return null;
        };
        const filePath = findFile(sessionsDir);
        if (filePath) {
          const destPath = path.join(archivedDir, path.basename(filePath));
          fs.renameSync(filePath, destPath);
        }
      } else if (provider === 'claude') {
        // Claude: 移动到项目目录下 .archived/ 子文件夹
        if (!projectDirName) {
          writeJson(res, 400, { ok: false, error: 'missing_projectDirName' });
          return true;
        }
        const projectDir = path.join(hostHome, '.claude', 'projects', projectDirName);
        const archivedDir = path.join(projectDir, '.archived');
        const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
          if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
          fs.renameSync(sessionFile, path.join(archivedDir, `${sessionId}.jsonl`));
        }
      } else if (provider === 'gemini') {
        // Gemini: 移动到 chats/.archived/ 子文件夹
        if (!projectDirName) {
          writeJson(res, 400, { ok: false, error: 'missing_projectDirName' });
          return true;
        }
        const chatsDir = path.join(hostHome, '.gemini', 'tmp', projectDirName, 'chats');
        const archivedDir = path.join(chatsDir, '.archived');
        if (fs.existsSync(chatsDir)) {
          for (const f of fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'))) {
            try {
              const chatPath = path.join(chatsDir, f);
              const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
              if (data.sessionId === sessionId || f.replace('.json', '') === sessionId) {
                if (!fs.existsSync(archivedDir)) fs.mkdirSync(archivedDir, { recursive: true });
                fs.renameSync(chatPath, path.join(archivedDir, f));
                break;
              }
            } catch (e) {}
          }
        }
      }

      // 清除项目缓存
      _projectsCache = null;
      _projectsCacheTime = 0;

      writeJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'archive_failed', message: msg });
      return true;
    }
  }


  // GET /v0/webui/sessions/archived - 获取所有已归档的会话
  if (method === 'GET' && pathname === '/v0/webui/sessions/archived') {
    try {
      const { getRealHome } = require('../sessions/session-reader');
      const hostHome = getRealHome();
      const archived = [];

      // Codex: 扫描 ~/.codex/archived_sessions/
      try {
        const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
        if (fs.existsSync(archivedDir)) {
          for (const entry of fs.readdirSync(archivedDir, { withFileTypes: true })) {
            if (!entry.name.endsWith('.jsonl')) continue;
            const fp = path.join(archivedDir, entry.name);
            const uuidMatch = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (!uuidMatch) continue;

            const stats = fs.statSync(fp);
            let title = '未命名会话';
            try {
              const indexPath = path.join(hostHome, '.codex', 'session_index.jsonl');
              if (fs.existsSync(indexPath)) {
                const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(l => l.trim());
                for (const line of lines) {
                  try {
                    const e = JSON.parse(line);
                    if (e.id === uuidMatch[1] && e.thread_name) title = e.thread_name;
                  } catch (e) {}
                }
              }
            } catch (e) {}

            archived.push({ id: uuidMatch[1], title, provider: 'codex', archivedAt: stats.mtimeMs });
          }
        }
      } catch (e) {}

      // Claude: 扫描各项目目录下的 .archived/ 子文件夹
      try {
        const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');
        if (fs.existsSync(claudeProjectsDir)) {
          for (const projectDirName of fs.readdirSync(claudeProjectsDir)) {
            const archivedDir = path.join(claudeProjectsDir, projectDirName, '.archived');
            if (!fs.existsSync(archivedDir)) continue;
            for (const f of fs.readdirSync(archivedDir).filter(f => f.endsWith('.jsonl'))) {
              const sessionId = f.replace('.jsonl', '');
              const fp = path.join(archivedDir, f);
              const stats = fs.statSync(fp);

              let title = '未命名会话';
              try {
                const fd = fs.openSync(fp, 'r');
                try {
                  const buf = Buffer.alloc(16384);
                  const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
                  const chunk = buf.toString('utf8', 0, bytesRead);
                  const lines = chunk.split('\n').filter(l => l.trim());
                  for (const line of lines) {
                    try {
                      const record = JSON.parse(line);
                      if (record.type === 'user' && record.message && record.message.content) {
                        let text = '';
                        if (typeof record.message.content === 'string') text = record.message.content;
                        else if (Array.isArray(record.message.content)) {
                          text = record.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
                        }
                        if (text && !text.startsWith('Caveat:') && !text.startsWith('<command-name>') &&
                            !text.startsWith('<local-command') && !text.startsWith('<ide_opened_file>')) {
                          title = text.slice(0, 50);
                          break;
                        }
                      }
                    } catch (e) {}
                  }
                } finally { fs.closeSync(fd); }
              } catch (e) {}

              archived.push({ id: sessionId, title, provider: 'claude', projectDirName, archivedAt: stats.mtimeMs });
            }
          }
        }
      } catch (e) {}

      // Gemini: 扫描各项目 chats/.archived/ 子文件夹
      try {
        const tmpDir = path.join(hostHome, '.gemini', 'tmp');
        if (fs.existsSync(tmpDir)) {
          for (const projectName of fs.readdirSync(tmpDir)) {
            const archivedDir = path.join(tmpDir, projectName, 'chats', '.archived');
            if (!fs.existsSync(archivedDir)) continue;
            for (const f of fs.readdirSync(archivedDir).filter(f => f.endsWith('.json'))) {
              try {
                const chatPath = path.join(archivedDir, f);
                const data = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
                const sessionId = data.sessionId || f.replace('.json', '');
                let title = data.summary || '';
                if (!title && data.messages && data.messages.length > 0) {
                  const firstUser = data.messages.find(m => m.type === 'user');
                  if (firstUser && firstUser.content) {
                    const textBlock = Array.isArray(firstUser.content)
                      ? firstUser.content.find(c => c.text) : firstUser.content;
                    title = (typeof textBlock === 'string' ? textBlock : textBlock?.text || '').slice(0, 50);
                  }
                }
                archived.push({ id: sessionId, title: title || '未命名会话', provider: 'gemini', projectDirName: projectName, archivedAt: fs.statSync(chatPath).mtimeMs });
              } catch (e) {}
            }
          }
        }
      } catch (e) {}

      archived.sort((a, b) => b.archivedAt - a.archivedAt);
      writeJson(res, 200, { ok: true, archived });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'get_archived_failed', message: msg });
      return true;
    }
  }

  // POST /v0/webui/sessions/unarchive - 还原归档会话
  if (method === 'POST' && pathname === '/v0/webui/sessions/unarchive') {
    const payload = await readRequestBody(req, { maxBytes: 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.provider || !payload.sessionId) {
      writeJson(res, 400, { ok: false, error: 'missing_params' });
      return true;
    }

    try {
      const { provider, sessionId, projectDirName } = payload;
      const { getRealHome } = require('../sessions/session-reader');
      const hostHome = getRealHome();

      if (provider === 'codex') {
        // Codex: 从 archived_sessions 移回 sessions 根目录
        const archivedDir = path.join(hostHome, '.codex', 'archived_sessions');
        const sessionsDir = path.join(hostHome, '.codex', 'sessions');
        if (fs.existsSync(archivedDir)) {
          for (const entry of fs.readdirSync(archivedDir)) {
            if (entry.includes(sessionId) && entry.endsWith('.jsonl')) {
              fs.renameSync(path.join(archivedDir, entry), path.join(sessionsDir, entry));
              break;
            }
          }
        }
      } else if (provider === 'claude') {
        // Claude: 从 .archived 移回项目目录
        if (projectDirName) {
          const projectDir = path.join(hostHome, '.claude', 'projects', projectDirName);
          const archivedFile = path.join(projectDir, '.archived', `${sessionId}.jsonl`);
          if (fs.existsSync(archivedFile)) {
            fs.renameSync(archivedFile, path.join(projectDir, `${sessionId}.jsonl`));
          }
        }
      } else if (provider === 'gemini') {
        // Gemini: 从 chats/.archived 移回 chats 目录
        if (projectDirName) {
          const chatsDir = path.join(hostHome, '.gemini', 'tmp', projectDirName, 'chats');
          const archivedDir = path.join(chatsDir, '.archived');
          if (fs.existsSync(archivedDir)) {
            for (const f of fs.readdirSync(archivedDir).filter(f => f.endsWith('.json'))) {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(archivedDir, f), 'utf8'));
                if (data.sessionId === sessionId || f.replace('.json', '') === sessionId) {
                  fs.renameSync(path.join(archivedDir, f), path.join(chatsDir, f));
                  break;
                }
              } catch (e) {}
            }
          }
        }
      }

      // 清除项目缓存
      _projectsCache = null;
      _projectsCacheTime = 0;

      writeJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'unarchive_failed', message: msg });
      return true;
    }
  }


  // GET /v0/webui/sessions/watch - SSE 监听会话文件变更
  if (method === 'GET' && pathname === '/v0/webui/sessions/watch') {
    const sessionId = url.searchParams?.get('sessionId') || '';
    const provider = url.searchParams?.get('provider') || '';
    const projectDirName = url.searchParams?.get('projectDirName') || '';

    if (!sessionId || !provider) {
      writeJson(res, 400, { ok: false, error: 'missing_params' });
      return true;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('data: {"type":"connected"}\n\n');

    const hostHome = require('os').homedir().includes('/.ai_home/profiles/')
      ? require('os').homedir().split('/.ai_home/')[0]
      : (process.env.REAL_HOME || require('os').homedir());

    // 确定要监控的文件路径
    let watchPath = null;
    if (provider === 'claude' && projectDirName) {
      watchPath = path.join(hostHome, '.claude', 'projects', projectDirName, `${sessionId}.jsonl`);
    }
    // Codex/Gemini 的文件路径不固定，暂不支持实时监听

    let watcher = null;
    if (watchPath && fs.existsSync(watchPath)) {
      let debounceTimer = null;
      watcher = fs.watch(watchPath, () => {
        // 防抖：500ms 内多次变更只触发一次
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'update', sessionId })}\n\n`);
          } catch (e) { /* client disconnected */ }
        }, 500);
      });
    }

    // 心跳
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 30000);

    // 清理
    req.on('close', () => {
      clearInterval(heartbeat);
      if (watcher) watcher.close();
    });

    return true;
  }

  // POST /v0/webui/chat - 发送聊天消息（直接转发到 v1 API）
  if (method === 'POST' && pathname === '/v0/webui/chat') {
    const payload = await readRequestBody(req, { maxBytes: 10 * 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.messages) {
      writeJson(res, 400, { ok: false, error: 'invalid_payload' });
      return true;
    }

    const { messages, provider, accountId, stream, model: requestModel } = payload;

    if (!provider || !accountId) {
      writeJson(res, 400, { ok: false, error: 'missing_account_info', detail: 'provider and accountId are required' });
      return true;
    }

    // Provider 默认模型映射
    const DEFAULT_MODELS = {
      codex: 'gpt-5.4',
      claude: 'claude-sonnet-4-20250514',
      gemini: 'gemini-2.5-pro'
    };

    // 优先使用前端传的 model，其次从 config.toml 读取，最后用默认值
    let model = requestModel || null;
    if (!model) {
      try {
        const configDir = getToolConfigDir(provider, accountId);
        const configPath = path.join(configDir, 'config.toml');
        if (fs.existsSync(configPath)) {
          const tomlContent = fs.readFileSync(configPath, 'utf8');
          const modelMatch = tomlContent.match(/^model\s*=\s*["']([^"']+)["']/m);
          if (modelMatch) model = modelMatch[1];
        }
      } catch (e) { /* ignore */ }
    }
    if (!model) {
      model = DEFAULT_MODELS[provider] || 'gpt-4o';
    }

    // 构建 OpenAI 兼容的请求
    const chatRequest = {
      model: model,
      messages: messages,
      stream: stream || false
    };

    try {
      // 使用 fetch 转发到 /v1/chat/completions
      const { fetchWithTimeout } = require('./http-utils');
      const apiUrl = `http://127.0.0.1:${options.port || 8317}/v1/chat/completions`;

      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${options.clientKey || 'dummy'}`,
          'X-Provider': provider,
          'X-Account-Id': accountId
        },
        body: JSON.stringify(chatRequest)
      }, 60000);

      if (!response.ok) {
        const errorText = await response.text();
        writeJson(res, response.status, {
          ok: false,
          error: 'upstream_error',
          message: errorText
        });
        return true;
      }

      if (stream) {
        // 流式响应 - 直接转发
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        response.body.pipe(res);
      } else {
        // 非流式响应 - 解析并返回
        const data = await response.json();
        const content = data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : '';

        writeJson(res, 200, {
          ok: true,
          content,
          model: data.model,
          usage: data.usage
        });
      }

      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'chat_failed', message: msg });
      return true;
    }
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
