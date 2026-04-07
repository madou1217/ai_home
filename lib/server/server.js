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
const {
  createProxyServerState,
  printProxyServeStartup
} = require('./server-runtime');

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
    logFile,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  // ✅ 创建 WebSocket 服务器用于 Codex /v1/responses 端点
  const wss = new WebSocket.Server({ noServer: true });

  // 处理 HTTP 升级请求 (WebSocket)
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';

    // 只处理 /v1/responses 路径
    if (pathname === '/v1/responses') {
      // 认证检查 (如果配置了 clientKey)
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

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      // 不支持的 WebSocket 路径
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  // 处理 WebSocket 连接
  wss.on('connection', (ws, req) => {
    const clientIp = requestClientIp(req);
    const requestId = createRequestId();

    if (options.verbose || options.debug) {
      console.log(`\x1b[90m[aih:ws]\x1b[0m Client connected: ${clientIp} (request_id: ${requestId})`);
    }

    // 处理来自客户端的消息
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (options.debug) {
          console.log(`\x1b[90m[aih:ws]\x1b[0m Received message from ${clientIp}:`, message);
        }

        // 目前 Codex 的 WebSocket 主要用于实时流式响应
        // 我们可以简单地返回一个确认消息
        ws.send(JSON.stringify({
          type: 'ack',
          request_id: requestId,
          message: 'WebSocket connection established'
        }));

      } catch (error) {
        if (options.debug) {
          console.error(`\x1b[31m[aih:ws]\x1b[0m Failed to parse message from ${clientIp}:`, error);
        }
      }
    });

    // 处理连接关闭
    ws.on('close', () => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:ws]\x1b[0m Client disconnected: ${clientIp} (request_id: ${requestId})`);
      }
    });

    // 处理错误
    ws.on('error', (error) => {
      if (options.debug) {
        console.error(`\x1b[31m[aih:ws]\x1b[0m WebSocket error for ${clientIp}:`, error);
      }
    });

    // 发送欢迎消息
    ws.send(JSON.stringify({
      type: 'connected',
      request_id: requestId,
      message: 'aih WebSocket server ready'
    }));
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

    // 关闭所有 WebSocket 连接
    wss.clients.forEach((ws) => {
      try {
        ws.close(1000, 'Server shutting down');
      } catch (_error) {}
    });

    // 关闭 WebSocket 服务器
    wss.close(() => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih]\x1b[0m WebSocket server closed`);
      }
    });

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
