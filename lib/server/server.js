'use strict';
const crypto = require('node:crypto');
const WebSocket = require('ws');

const {
  FALLBACK_MODELS,
  initModelRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
} = require('./models');
const { renderProxyStatusPage } = require('./status-page');
const {
  initProxyMetrics,
  createProviderExecutor,
  pushMetricError
} = require('./local');
const { createAccountStateIndex } = require('../account/state-index');
const {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream
} = require('./http-utils');
const { loadServerRuntimeAccounts } = require('./accounts');
const {
  resolveRequestProvider,
  chooseServerAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
} = require('./router');
const {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  buildManagementAccountsPayload,
  applyReloadState
} = require('./management');
const { buildManagementModelsResponse } = require('./model-endpoints');
const {
  handleUpstreamModels,
  handleUpstreamPassthrough
} = require('./upstream-endpoints');
const {
  handleCodexModels,
  handleCodexChatCompletions
} = require('./codex-adapter');
const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { createTokenRefreshDaemon } = require('./token-refresh-daemon');
const { handleManagementRequest } = require('./management-router');
const { handleV1Request } = require('./v1-router');
const { handleWebUIRequest } = require('./web-ui-router');
const { startRuntimeRecoveryDaemon } = require('./runtime-recovery-daemon');
const {
  createProxyServerState,
  printProxyServeStartup
} = require('./server-runtime');
const { refreshWebUiModelsCache } = require('./webui-model-cache');
const {
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
} = require('./server-config-store');
const { pickProjectDirectory } = require('./project-picker');

const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 70_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 75_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;

function createRequestId() {
  try {
    return crypto.randomBytes(4).toString('hex');
  } catch (_error) {
    return String(Date.now());
  }
}

function requestClientIp(req) {
  const viaHeader = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (viaHeader) return viaHeader;
  return String((req.socket && req.socket.remoteAddress) || '').trim() || 'unknown';
}

async function startLocalServer(options, deps) {
  const {
    http,
    fs,
    aiHomeDir,
    processObj,
    spawn,
    logFile,
    entryFilePath,
    nodeExecPath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    ensureSessionStoreLinks
  } = deps;
  const accountStateIndex = createAccountStateIndex({
    aiHomeDir,
    fs
  });

  function appendProxyRequestLog(entry) {
    const line = JSON.stringify(entry);
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch (e) {}
  }

  const state = createProxyServerState(options, {
    loadServerRuntimeAccounts,
    initProxyMetrics,
    createProviderExecutor,
    initModelRegistry,
    fs,
    aiHomeDir,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });

  const requiredClientKey = String(options.clientKey || '').trim();
  const requiredManagementKey = String(options.managementKey || '').trim();
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 60000);
  const maxRequestBodyBytes = Math.max(1024, Number(options.maxRequestBodyBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES);

  const server = http.createServer(async (req, res) => {
    const requestId = createRequestId();
    const startedAt = Date.now();
    const clientIp = requestClientIp(req);
    res.setHeader('x-aih-request-id', requestId);

    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';
    const requestMeta = { requestId, clientIp, method, pathname };
    let loggedAccess = false;
    const logAccessOnce = () => {
      if (loggedAccess || !options.logRequests) return;
      loggedAccess = true;
      appendProxyRequestLog({
        at: new Date().toISOString(),
        kind: 'access',
        requestId,
        method,
        path: pathname,
        status: Number(res.statusCode || 0),
        durationMs: Date.now() - startedAt,
        clientIp
      });
    };
    res.once('finish', logAccessOnce);
    res.once('close', logAccessOnce);
    try {
      if (pathname === '/healthz') {
        return writeJson(res, 200, { ok: true, service: 'aih-server' });
      }
      if (pathname === '/readyz') {
        const codexReady = Array.isArray(state.accounts.codex) && state.accounts.codex.length > 0;
        const geminiReady = Array.isArray(state.accounts.gemini) && state.accounts.gemini.length > 0;
        const claudeReady = Array.isArray(state.accounts.claude) && state.accounts.claude.length > 0;
        return writeJson(res, 200, {
          ok: true,
          service: 'aih-server',
          ready: codexReady || geminiReady || claudeReady,
          accounts: {
            codex: state.accounts.codex.length,
            gemini: state.accounts.gemini.length,
            claude: state.accounts.claude.length
          }
        });
      }

      const handledWebUI = await handleWebUIRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        deps: {
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
          aiHomeDir,
          ensureSessionStoreLinks,
          pickProjectDirectory,
          fetchModelsForAccount,
          readServerConfig: () => readServerConfig({ fs, aiHomeDir }),
          writeServerConfig: (config) => writeServerConfig(config, { fs, aiHomeDir }),
          restartServerWithStoredConfig: async () => {
            const config = readServerConfig({ fs, aiHomeDir });
            const restartArgs = buildServerArgsFromConfig(config);
            const child = spawn(nodeExecPath || process.execPath, [entryFilePath, 'server', 'restart', ...restartArgs], {
              detached: true,
              stdio: 'ignore',
              env: processObj.env || process.env
            });
            child.unref();
            return {
              ok: true,
              pid: child.pid,
              appliedConfig: config
            };
          }
        }
      });
      if (handledWebUI) return;

      const handledManagement = await handleManagementRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        requiredManagementKey,
        deps: {
          parseAuthorizationBearer,
          writeJson,
          renderProxyStatusPage,
          buildManagementStatusPayload,
          buildManagementMetricsPayload,
          buildManagementModelsResponse,
          buildManagementAccountsPayload,
          loadServerRuntimeAccounts,
          applyReloadState,
          fetchModelsForAccount,
          getRegistryModelList,
          accountStateIndex,
          fs,
          getToolAccountIds,
          getToolConfigDir,
          getProfileDir,
          checkStatus,
          readRequestBody
        }
      });
      if (handledManagement) return;

      const handledV1 = await handleV1Request({
        req,
        res,
        method,
        pathname,
        options,
        state,
        requiredClientKey,
        cooldownMs,
        maxRequestBodyBytes,
        requestMeta,
        deps: {
          parseAuthorizationBearer,
          writeJson,
          readRequestBody,
          buildOpenAIModelsList,
          resolveRequestProvider,
          chooseServerAccount,
          markProxyAccountSuccess,
          markProxyAccountFailure,
          pushMetricError,
          appendProxyRequestLog,
          handleUpstreamModels,
          handleUpstreamPassthrough,
          handleCodexModels,
          handleCodexChatCompletions,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          FALLBACK_MODELS,
          fetchWithTimeout,
          refreshCodexAccessToken
        }
      });
      if (handledV1) return;

      return writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const msg = String((error && error.stack) || (error && error.message) || error || 'unknown_error');
      console.error(`\x1b[31m[aih]\x1b[0m request handler failed: ${msg}`);
      if (!res.writableEnded) {
        writeJson(res, 500, { ok: false, error: 'internal_server_error' });
      }
    }
  });
  server.requestTimeout = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  server.headersTimeout = Math.max(1000, Number(options.headersTimeoutMs) || DEFAULT_HEADERS_TIMEOUT_MS);
  server.keepAliveTimeout = Math.max(1000, Number(options.keepAliveTimeoutMs) || DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  const runtimeRecovery = startRuntimeRecoveryDaemon(state, {
    intervalMs: Number(options.runtimeRecoveryIntervalMs) || 15000
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  setImmediate(() => {
    refreshWebUiModelsCache(state, options, {
      fetchModelsForAccount
    }).catch((_error) => {
      // best effort prewarm; request path can retry later
    });
  });

  // ✅ WebSocket 代理: 将客户端连接转发到 Codex 上游服务器
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';
    const requestId = createRequestId();
    const clientIp = requestClientIp(req);

    // 只处理 /v1/responses 路径
    if (pathname !== '/v1/responses') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // 认证检查
    if (requiredClientKey) {
      const authHeader = String(req.headers.authorization || '').trim();
      const incoming = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
      if (incoming !== requiredClientKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    try {
      // 选择可用的 Codex 账号
      const pool = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
      const account = chooseServerAccount(pool, state.cursors, 'codex', {
        provider: 'codex',
        sessionKey: '',
        excludeIds: []
      });

      if (!account || !account.accessToken) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ ok: false, error: 'no_available_account' }));
        socket.destroy();
        return;
      }

      // ✅ 构建上游 WebSocket URL
      // - API Key 模式: 使用账号配置的 openai_base_url (中转服务器)
      // - OAuth 模式: 使用默认的 codexBaseUrl (官方 ChatGPT API)
      let upstreamBaseUrl = String(options.codexBaseUrl || '').trim().replace(/\/+$/, '');

      // 检查账号是否使用 API Key 模式 (有 openaiBaseUrl 配置)
      if (account.openaiBaseUrl && String(account.openaiBaseUrl).trim()) {
        upstreamBaseUrl = String(account.openaiBaseUrl).trim().replace(/\/+$/, '');
        if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:ws]\x1b[0m Account ${account.id} uses API Key mode with base URL: ${upstreamBaseUrl}`);
        }
      }

      const upstreamUrl = upstreamBaseUrl.replace(/^https?:/, 'wss:') + '/responses';

      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:ws]\x1b[0m Client ${clientIp} -> upstream ${upstreamUrl} (account ${account.id})`);
      }

      // 创建到上游的 WebSocket 连接
      const upstream = new WebSocket(upstreamUrl, {
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'User-Agent': req.headers['user-agent'] || 'aih-proxy'
        }
      });

      // 等待上游连接建立
      await new Promise((resolve, reject) => {
        upstream.once('open', resolve);
        upstream.once('error', reject);
        setTimeout(() => reject(new Error('upstream_timeout')), 10000);
      });

      // 升级客户端连接
      const wss = new WebSocket.Server({ noServer: true });
      wss.handleUpgrade(req, socket, head, (client) => {
        if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:ws]\x1b[0m WebSocket relay established (request_id: ${requestId})`);
        }

        // 双向转发消息
        client.on('message', (data) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data);
          }
        });

        upstream.on('message', (data) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });

        // 错误处理
        client.on('error', (error) => {
          if (options.debug) {
            console.error(`\x1b[31m[aih:ws]\x1b[0m Client error:`, error.message);
          }
          upstream.close();
        });

        upstream.on('error', (error) => {
          if (options.debug) {
            console.error(`\x1b[31m[aih:ws]\x1b[0m Upstream error:`, error.message);
          }
          client.close();
        });

        // 连接关闭
        client.on('close', () => {
          if (options.verbose || options.debug) {
            console.log(`\x1b[90m[aih:ws]\x1b[0m Client disconnected (request_id: ${requestId})`);
          }
          upstream.close();
        });

        upstream.on('close', () => {
          if (options.verbose || options.debug) {
            console.log(`\x1b[90m[aih:ws]\x1b[0m Upstream disconnected (request_id: ${requestId})`);
          }
          client.close();
        });
      });

    } catch (error) {
      const errorMsg = String((error && error.message) || error || 'unknown');
      console.error(`\x1b[31m[aih:ws]\x1b[0m WebSocket upgrade failed: ${errorMsg}`);
      socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n\r\n`);
      socket.write(JSON.stringify({ ok: false, error: 'upstream_failed', detail: errorMsg }));
      socket.destroy();
    }
  });

  // 启动后台 Token 自动刷新守护进程
  const tokenRefreshDaemon = createTokenRefreshDaemon(state, options, {
    fetchWithTimeout,
    logInfo: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:token-refresh]\x1b[0m ${msg}`);
      }
    },
    logWarn: (msg) => {
      console.warn(`\x1b[33m[aih:token-refresh]\x1b[0m ${msg}`);
    },
    logError: (msg) => {
      console.error(`\x1b[31m[aih:token-refresh]\x1b[0m ${msg}`);
    }
  });

  let shuttingDown = false;
  const stopServer = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\x1b[90m[aih]\x1b[0m received ${signal}, shutting down server...`);

    // 停止 Token 刷新守护进程
    if (tokenRefreshDaemon && typeof tokenRefreshDaemon.stop === 'function') {
      tokenRefreshDaemon.stop();
    }
    if (runtimeRecovery && typeof runtimeRecovery.stop === 'function') {
      runtimeRecovery.stop();
    }

    server.close(() => {
      processObj.exit(0);
    });
    setTimeout(() => {
      processObj.exit(1);
    }, 5000).unref();
  };
  processObj.once('SIGTERM', () => stopServer('SIGTERM'));
  processObj.once('SIGINT', () => stopServer('SIGINT'));

  printProxyServeStartup(options, state, requiredClientKey, requiredManagementKey);

  // 在启动信息后打印 Token 刷新守护进程状态
  if (options.verbose || options.debug) {
    const stats = tokenRefreshDaemon.getStats();
    console.log(`\x1b[90m[aih]\x1b[0m Token refresh daemon started (interval: ${stats.refreshIntervalMs}ms, skew: ${stats.skewMs}ms)`);
  }
}

module.exports = {
  startLocalServer
};
