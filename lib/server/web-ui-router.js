'use strict';
const path = require('node:path');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

// 项目列表缓存（避免每次请求都扫描文件系统）
let _projectsCache = null;
let _projectsCacheTime = 0;
const PROJECTS_CACHE_TTL = 120000; // 120秒

// 后台自动刷新缓存
let _bgRefreshTimer = null;
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

        accounts.push({
          provider,
          accountId,
          displayName: stateInfo.display_name || `${provider}-${accountId}`,
          configured,
          apiKeyMode,
          exhausted: stateInfo.exhausted || false,
          remainingPct: stateInfo.remaining_pct || 0,
          updatedAt: stateInfo.updated_at || 0,
          configDir,
          profileDir
        });
      }
    }

    writeJson(res, 200, { ok: true, accounts });
    return true;
  }

  // POST /v0/webui/accounts/add - 添加新账号
  if (method === 'POST' && pathname === '/v0/webui/accounts/add') {
    const payload = await readRequestBody(req, { maxBytes: 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.provider || !payload.accountId) {
      writeJson(res, 400, { ok: false, error: 'invalid_payload' });
      return true;
    }

    const { provider, accountId, config } = payload;

    if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
      writeJson(res, 400, { ok: false, error: 'unsupported_provider' });
      return true;
    }

    try {
      // 创建账号目录结构
      const profileDir = getProfileDir(provider, accountId);
      fs.ensureDirSync(profileDir);

      // 如果提供了配置，写入配置文件
      if (config) {
        const configDir = getToolConfigDir(provider, accountId);
        fs.ensureDirSync(configDir);

        if (provider === 'codex' && config.apiKey) {
          // 写入 Codex 配置
          const configPath = path.join(configDir, 'config.toml');
          const tomlContent = `api_key = "${config.apiKey}"\n`;
          if (config.baseUrl) {
            tomlContent += `base_url = "${config.baseUrl}"\n`;
          }
          fs.writeFileSync(configPath, tomlContent, 'utf8');
        } else if (provider === 'claude' && config.apiKey) {
          // 写入 Claude 配置
          const sessionPath = path.join(configDir, 'session.json');
          fs.writeFileSync(sessionPath, JSON.stringify({
            sessionKey: config.apiKey
          }, null, 2), 'utf8');
        } else if (provider === 'gemini' && config.apiKey) {
          // 写入 Gemini 配置
          const configPath = path.join(configDir, 'config.json');
          fs.writeFileSync(configPath, JSON.stringify({
            apiKey: config.apiKey
          }, null, 2), 'utf8');
        }
      }

      // 更新账号状态索引
      accountStateIndex.upsertAccountState(provider, accountId, {
        configured: true,
        api_key_mode: Boolean(config && config.apiKey),
        display_name: `${provider}-${accountId}`
      });

      // 重新加载账号
      const runtimeAccounts = loadServerRuntimeAccounts({
        fs,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus
      });
      applyReloadState(state, runtimeAccounts);

      writeJson(res, 200, { ok: true, provider, accountId });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'add_account_failed', message: msg });
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
        fs.removeSync(profileDir);
      }

      // 从状态索引中移除
      accountStateIndex.removeAccount(provider, accountId);

      // 重新加载账号
      const runtimeAccounts = loadServerRuntimeAccounts({
        fs,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus
      });
      applyReloadState(state, runtimeAccounts);

      writeJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      writeJson(res, 500, { ok: false, error: 'delete_account_failed', message: msg });
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

  // POST /v0/webui/chat - 发送聊天消息（直接转发到 v1 API）
  if (method === 'POST' && pathname === '/v0/webui/chat') {
    const payload = await readRequestBody(req, { maxBytes: 10 * 1024 * 1024 })
      .then(buf => buf ? JSON.parse(buf.toString('utf8')) : null)
      .catch(() => null);

    if (!payload || !payload.messages) {
      writeJson(res, 400, { ok: false, error: 'invalid_payload' });
      return true;
    }

    const { messages, provider, accountId, stream } = payload;

    if (!provider || !accountId) {
      writeJson(res, 400, { ok: false, error: 'missing_account_info', detail: 'provider and accountId are required' });
      return true;
    }

    // 从账号配置读取模型
    let model = null;
    try {
      const configDir = getToolConfigDir(provider, accountId);
      const configPath = path.join(configDir, 'config.toml');

      if (fs.existsSync(configPath)) {
        const tomlContent = fs.readFileSync(configPath, 'utf8');
        // 简单解析 TOML 的 model 字段
        const modelMatch = tomlContent.match(/^model\s*=\s*["']([^"']+)["']/m);
        if (modelMatch) {
          model = modelMatch[1];
        }
      }
    } catch (e) {
      console.error('Failed to read model from config:', e);
    }

    // 如果没有配置模型,返回错误
    if (!model) {
      writeJson(res, 400, {
        ok: false,
        error: 'no_model_configured',
        detail: `Account ${provider}-${accountId} does not have a model configured in config.toml`
      });
      return true;
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
