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
const { pickPersistedAccountRuntimeState } = require('./account-runtime-state');
const {
  getApiKeyDisplayName,
  pickOauthDisplayName
} = require('./account-display-identity');
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
const {
  createCodexAppServerProxy,
  isCodexAppServerUpgradePath
} = require('./codex-app-server-proxy');
const { createCodexDesktopHookService } = require('./codex-desktop-hook');
const { createCodexCliHookService } = require('./codex-cli-hook');

const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 70_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 75_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;

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
    hostHomeDir,
    processObj,
    spawn,
    spawnSync,
    path,
    resolveCliPath,
    logFile,
    entryFilePath,
    nodeExecPath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    ensureSessionStoreLinks,
    enableCodexDesktopAppHook,
    enableCodexCliHook
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
    accountStateIndex,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });

  function persistAccountRuntimeState(account) {
    if (!account || !accountStateIndex || typeof accountStateIndex.upsertRuntimeState !== 'function') return;
    const provider = String(account.provider || '').trim().toLowerCase();
    const accountId = String(account.id || '').trim();
    if (!provider || !accountId) return;
    accountStateIndex.upsertRuntimeState(
      provider,
      accountId,
      pickPersistedAccountRuntimeState(account),
      {
        configured: true,
        apiKeyMode: Boolean(account.apiKeyMode || account.authType === 'api-key'),
        displayName: Boolean(account.apiKeyMode || account.authType === 'api-key')
          ? getApiKeyDisplayName(provider, account)
          : pickOauthDisplayName(account.email, account.displayName)
      }
    );
  }

  function markProxyAccountSuccessAndPersist(account) {
    markProxyAccountSuccess(account);
    persistAccountRuntimeState(account);
  }

  function markProxyAccountFailureAndPersist(account, reason, cooldownMs, failureThreshold) {
    markProxyAccountFailure(account, reason, cooldownMs, failureThreshold);
    persistAccountRuntimeState(account);
  }

  const requiredClientKey = String(options.clientKey || '').trim();
  const requiredManagementKey = String(options.managementKey || '').trim();
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 60000);
  const maxRequestBodyBytes = Math.max(1024, Number(options.maxRequestBodyBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES);
  const codexAppServerProxy = createCodexAppServerProxy({
    spawn,
    processObj,
    path,
    resolveCliPath,
    hostHomeDir,
    logDebug: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:codex-proxy]\x1b[0m ${msg}`);
      }
    },
    logError: (error) => {
      const msg = String((error && error.message) || error || 'unknown_error');
      console.error(`\x1b[31m[aih:codex-proxy]\x1b[0m ${msg}`);
    }
  });
  const codexDesktopHookService = enableCodexDesktopAppHook
    ? createCodexDesktopHookService({
      fs,
      path,
      processObj,
      spawnSync,
      aiHomeDir,
      hostHomeDir,
      nodeExecPath
    })
    : null;
  const codexCliHookService = enableCodexCliHook
    ? createCodexCliHookService({
      fs,
      path,
      processObj,
      aiHomeDir,
      nodeExecPath,
      resolveCliPath
    })
    : null;

  if (codexCliHookService) {
    try {
      const hookResult = codexCliHookService.ensureInstalled();
      if ((options.verbose || options.debug) && hookResult && hookResult.supported) {
        const hookState = hookResult.enabled ? 'enabled' : (hookResult.reason || 'disabled');
        console.log(`\x1b[90m[aih:codex-cli-hook]\x1b[0m cli hook ${hookState}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih:codex-cli-hook]\x1b[0m ${String((error && error.message) || error || 'hook_failed')}`);
    }
  }

  const codexCliHookSelfHeal = codexCliHookService
    ? (() => {
      const intervalMs = Math.max(
        1_000,
        Number(options.codexCliHookSelfHealIntervalMs) || DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS
      );
      let repairing = false;
      const tick = () => {
        if (repairing) return;
        repairing = true;
        try {
          const result = codexCliHookService.ensureInstalled();
          if (result && result.repaired) {
            console.log(`\x1b[36m[aih:codex-cli-hook]\x1b[0m repaired cli hook at ${String(result.targetBinaryPath || '').trim()}`);
          }
        } catch (error) {
          const msg = String((error && error.message) || error || 'hook_failed');
          console.warn(`\x1b[33m[aih:codex-cli-hook]\x1b[0m self-heal failed: ${msg}`);
        } finally {
          repairing = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop() {
          clearInterval(timer);
        },
        tick
      };
    })()
    : null;

  if (codexDesktopHookService) {
    try {
      const hookResult = codexDesktopHookService.activate();
      if (options.codexDesktopTraceFile || options.codexDesktopTraceResponses) {
        codexDesktopHookService.updateTraceConfig({
          traceFile: options.codexDesktopTraceFile,
          traceResponses: options.codexDesktopTraceResponses
        });
      }
      if ((options.verbose || options.debug) && hookResult && hookResult.supported) {
        const hookState = hookResult.enabled ? 'enabled' : (hookResult.reason || 'disabled');
        console.log(`\x1b[90m[aih:codex-hook]\x1b[0m desktop hook ${hookState}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih:codex-hook]\x1b[0m ${String((error && error.message) || error || 'hook_failed')}`);
    }
  }

  const codexDesktopHookSelfHeal = codexDesktopHookService
    ? (() => {
      const intervalMs = Math.max(
        1_000,
        Number(options.codexDesktopHookSelfHealIntervalMs) || DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS
      );
      let repairing = false;
      const tick = () => {
        if (repairing) return;
        repairing = true;
        try {
          const result = codexDesktopHookService.ensureInstalled();
          if (result && result.repaired) {
            if (options.codexDesktopTraceFile || options.codexDesktopTraceResponses) {
              codexDesktopHookService.updateTraceConfig({
                traceFile: options.codexDesktopTraceFile,
                traceResponses: options.codexDesktopTraceResponses
              });
            }
            console.log(`\x1b[36m[aih:codex-hook]\x1b[0m repaired desktop hook at ${String(result.targetBinaryPath || '').trim()}`);
          }
        } catch (error) {
          const msg = String((error && error.message) || error || 'hook_failed');
          console.warn(`\x1b[33m[aih:codex-hook]\x1b[0m self-heal failed: ${msg}`);
        } finally {
          repairing = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop() {
          clearInterval(timer);
        },
        tick
      };
    })()
    : null;

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
          getLastUsageProbeError,
          getLastUsageProbeState,
          ensureUsageSnapshotAsync,
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
          markProxyAccountSuccess: markProxyAccountSuccessAndPersist,
          markProxyAccountFailure: markProxyAccountFailureAndPersist,
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

    const isResponsesPath = pathname === '/v1/responses';
    const isCodexAppServerPath = isCodexAppServerUpgradePath(pathname);
    if (!isResponsesPath && !isCodexAppServerPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

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

    if (isCodexAppServerPath) {
      try {
        await codexAppServerProxy.handleUpgrade(req, socket, head, { requestId, clientIp });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:codex-proxy]\x1b[0m upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
      return;
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
      if (isLoopbackUrl(upstreamBaseUrl, options.port)) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ ok: false, error: 'infinite_loop_detected' }));
        socket.destroy();
        return;
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
    if (codexCliHookSelfHeal && typeof codexCliHookSelfHeal.stop === 'function') {
      codexCliHookSelfHeal.stop();
    }
    if (codexDesktopHookSelfHeal && typeof codexDesktopHookSelfHeal.stop === 'function') {
      codexDesktopHookSelfHeal.stop();
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
