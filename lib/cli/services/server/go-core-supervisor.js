'use strict';

const nodePath = require('node:path');
const {
  computeRouteManifestHash,
  readPackageVersion,
  verifyBuildStamp
} = require('./go-core-build-stamp');

const DEFAULT_GO_CORE_HOST = '127.0.0.1';
const DEFAULT_GO_CORE_PORT = 19550;
const DEFAULT_PUBLIC_PORT = 9527;
const DEFAULT_READY_TIMEOUT_MS = 7000;
// 后台重试不阻塞 Node 启动，可以更有耐心：就绪门限随重试翻倍，直到这个上限。
const MAX_RETRY_READY_TIMEOUT_MS = 60 * 1000;
const DEFAULT_STOP_TIMEOUT_MS = 3000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30000;
// 连续稳定服务超过该时长才把退避清零，避免「起来即崩」的崩溃循环每秒重启一次。
const DEFAULT_RESTART_STABLE_MS = 60000;
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
// 持续失败时（比如构件不匹配，等人重新构建）每次退避都会重试；日志只在错误类型变化时写，
// 否则至多 10 分钟一条，避免刷屏。
const FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;

function nonEmpty(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveValue(value) {
  return typeof value === 'function' ? value() : value;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function createSupervisorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 解析与当前 Node Host 版本匹配的 Go Server 构件，不回退到其它 Go CLI。 */
function resolveRepositoryRoot(options = {}) {
  const pathImpl = options.path || nodePath;
  return pathImpl.resolve(nonEmpty(options.repositoryRoot) || pathImpl.join(__dirname, '../../../..'));
}

function resolveGoServerBinary(options = {}) {
  const pathImpl = options.path || nodePath;
  const explicit = nonEmpty(options.binaryPath || options.goServerBinary);
  if (explicit) return pathImpl.resolve(explicit);
  const repositoryRoot = resolveRepositoryRoot(options);
  const platform = nonEmpty(options.platform || process.platform);
  const arch = nonEmpty(options.arch || process.arch);
  const directory = pathImpl.join(repositoryRoot, 'bin', 'native', `${platform}-${arch}`);
  return pathImpl.join(directory, platform === 'win32' ? 'aih-server.exe' : 'aih-server');
}

/** 校验 Go Core 只能使用 loopback 私有端口，明确拒绝公开 9527。 */
function validatePrivateEndpoint(options = {}) {
  const host = nonEmpty(options.host === undefined ? DEFAULT_GO_CORE_HOST : options.host);
  const port = Number(options.port === undefined ? DEFAULT_GO_CORE_PORT : options.port);
  const publicPort = Number(options.publicPort === undefined ? DEFAULT_PUBLIC_PORT : options.publicPort);
  if (!isLoopbackHost(host)) {
    throw createSupervisorError('go_core_endpoint_not_private', 'Go Core endpoint 必须绑定 loopback');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createSupervisorError('go_core_endpoint_invalid', 'Go Core endpoint 端口无效');
  }
  if (port === publicPort || port === DEFAULT_PUBLIC_PORT) {
    throw createSupervisorError('go_core_endpoint_conflicts_public', 'Go Core 不得占用公开 9527');
  }
  return { host, port, publicPort };
}

function buildGoCoreEnvironment(options = {}, endpoint) {
  const environment = {
    ...(options.baseEnv || process.env),
    ...(options.env || {}),
    AIH_HOME: nonEmpty(options.aiHomeDir),
    AIH_SERVER_HOST: endpoint.host,
    AIH_SERVER_PORT: String(endpoint.port),
    AIH_SERVER_MANAGEMENT_KEY: nonEmpty(resolveValue(options.managementKey)),
    AIH_SERVER_CLIENT_KEY: nonEmpty(resolveValue(options.clientKey)),
  };
  // Node 账号同步在跑时 Node 是唯一 OAuth 刷新者；Go 自行轮换 Refresh Token 会让 Node 的副本失效。
  if (options.delegateCredentialRefresh) environment.AIH_SERVER_CREDENTIAL_REFRESH = 'delegated';
  else delete environment.AIH_SERVER_CREDENTIAL_REFRESH;
  return environment;
}

/** 构造不把内部密钥放入 argv 的 Go Server 启动合同。 */
function buildGoCoreInvocation(options = {}) {
  const endpoint = validatePrivateEndpoint(options);
  const aiHomeDir = nonEmpty(options.aiHomeDir);
  const managementKey = nonEmpty(resolveValue(options.managementKey));
  const clientKey = nonEmpty(resolveValue(options.clientKey));
  if (!aiHomeDir || !managementKey || !clientKey) {
    throw createSupervisorError('go_core_credentials_missing', 'Go Core 运行目录和内部密钥不能为空');
  }
  const command = resolveGoServerBinary(options);
  return {
    command,
    args: ['--host', endpoint.host, '--port', String(endpoint.port)],
    env: buildGoCoreEnvironment({ ...options, aiHomeDir, managementKey, clientKey }, endpoint),
    endpoint,
  };
}

// 监督门限是「进程已在私有端点提供服务」（/healthz），而不是「已有账号」（/readyz.ready）。
// 账号由 Node 在 Go 起来之后同步进去；若以账号为门限，全新安装永远起不来（先有鸡还是先有蛋）。
function responseIsServing(response, body) {
  return Boolean(
    response && response.ok
    && body && body.service === 'aih-server'
    && body.ok === true,
  );
}

/**
 * Go Core stdout/stderr 的落盘端：追加写入 <AIH_HOME>/logs/go-core.log，超过上限时轮转为 .1。
 * 写失败只丢日志，不影响监督。
 */
function createGoCoreLogSink(options = {}) {
  const fs = options.fs;
  const pathImpl = options.path || nodePath;
  const file = options.logFile === undefined
    ? (nonEmpty(options.aiHomeDir) ? pathImpl.join(nonEmpty(options.aiHomeDir), 'logs', 'go-core.log') : '')
    : nonEmpty(options.logFile);
  const maxBytes = Number(options.maxBytes) || DEFAULT_LOG_MAX_BYTES;
  if (!file || !fs || typeof fs.appendFileSync !== 'function') return { file: '', write() {} };
  let prepared = false;
  return {
    file,
    write(stream, chunk) {
      try {
        if (!prepared) {
          fs.mkdirSync(pathImpl.dirname(file), { recursive: true });
          prepared = true;
        }
        if (typeof fs.statSync === 'function' && fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
          fs.renameSync(file, `${file}.1`);
        }
        const text = String(chunk);
        const stamp = new Date().toISOString();
        const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
        if (lines.length === 0) return;
        fs.appendFileSync(file, lines.map((line) => `${stamp} [${stream}] ${line}\n`).join(''), { mode: 0o600 });
      } catch (_error) {}
    }
  };
}

/** 创建 Node 侧显式 opt-in 的 Go Core 进程监督器。 */
function createGoCoreSupervisor(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const pathImpl = deps.path || nodePath;
  const spawn = deps.spawn || require('node:child_process').spawn;
  const fetchImpl = deps.fetchImpl || fetch;
  const processObj = deps.processObj || process;
  const sleep = deps.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const enabled = deps.enabled === true;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const now = deps.now || Date.now;
  const autoRestart = deps.autoRestart !== false;
  const restartBaseDelayMs = Number(deps.restartBaseDelayMs) || DEFAULT_RESTART_BASE_DELAY_MS;
  const restartMaxDelayMs = Number(deps.restartMaxDelayMs) || DEFAULT_RESTART_MAX_DELAY_MS;
  const restartStableMs = Number(deps.restartStableMs) || DEFAULT_RESTART_STABLE_MS;
  // 重启（含启动失败后的重试）成功时通知宿主，让它重新对账并恢复转发。
  const onRestarted = typeof deps.onRestarted === 'function' ? deps.onRestarted : null;
  const logSink = createGoCoreLogSink({ fs, path: pathImpl, aiHomeDir: deps.aiHomeDir, logFile: deps.logFile });
  let child = null;
  let restartTimer = null;
  let restartAttempts = 0;
  let restarts = 0;
  let readyAt = 0;
  let state = enabled ? 'stopped' : 'disabled';
  let lastError = null;
  let currentEndpoint = null;
  let stopping = false;
  // 外部调用 stop() 之后不再自动拉起；内部的「未就绪即停」不算。
  let shutDown = false;
  let lastLoggedFailure = { code: '', at: 0 };
  let startPromise = null;
  let childExited = false;

  function status() {
    return {
      enabled,
      state,
      pid: child && Number(child.pid) > 0 ? Number(child.pid) : 0,
      endpoint: currentEndpoint ? `http://${currentEndpoint.host}:${currentEndpoint.port}` : '',
      error: lastError ? lastError.code || 'go_core_failed' : '',
      restarts,
      restartPending: Boolean(restartTimer),
      restartAttempts,
      logFile: logSink.file,
    };
  }

  // 意外退出或启动失败后按指数退避重新拉起；在途请求不重放，已划转路由在此期间交还 Node。
  // 启动失败也必须重试：只在崩溃时重启的话，一次「未就绪」或构件不匹配就会让 Go 永久停摆。
  function scheduleRestart() {
    if (!autoRestart || restartTimer || stopping || shutDown) return;
    if (readyAt && now() - readyAt >= restartStableMs) restartAttempts = 0;
    const delay = Math.min(restartMaxDelayMs, restartBaseDelayMs * (2 ** restartAttempts));
    restartAttempts += 1;
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (shutDown) return;
      restarts += 1;
      // Go 先同步探测 codex 版本再开始监听（每条命令最长 3 秒），慢机器上可能超过首启门限；
      // 门限不变的话，每次重试都会在同一处被杀掉。
      const readyTimeoutMs = Math.min(MAX_RETRY_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS * (2 ** restartAttempts));
      start({ scheduled: true, readyTimeoutMs })
        .then((restartedStatus) => {
          if (onRestarted && !shutDown && restartedStatus && restartedStatus.state === 'ready') onRestarted(restartedStatus);
        })
        .catch(() => scheduleRestart());
    }, delay);
    if (restartTimer && typeof restartTimer.unref === 'function') restartTimer.unref();
  }

  function pipeOutput(processHandle) {
    for (const stream of ['stdout', 'stderr']) {
      const source = processHandle && processHandle[stream];
      if (source && typeof source.on === 'function') source.on('data', (chunk) => logSink.write(stream, chunk));
    }
  }

  function attachLifecycle(processHandle) {
    if (typeof processHandle.once !== 'function') return;
    processHandle.once('error', (error) => {
      if (child !== processHandle || stopping) return;
      lastError = createSupervisorError('go_core_process_error', String(error && error.message || error));
      state = 'failed';
    });
    processHandle.once('exit', (code, signal) => {
      childExited = true;
      if (child !== processHandle || stopping) return;
      child = null;
      state = code === 0 ? 'stopped' : 'failed';
      lastError = code === 0
        ? null
        : createSupervisorError('go_core_process_exit', `Go Core 退出 code=${code} signal=${signal || ''}`);
      logSink.write('supervisor', `Go Core exited code=${code} signal=${signal || ''}`);
      scheduleRestart();
    });
  }

  async function waitForServing(endpoint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!child || state === 'failed') return false;
      try {
        const response = await fetchImpl(`http://${endpoint.host}:${endpoint.port}/healthz`);
        let body = null;
        if (typeof response.json === 'function') body = await response.json();
        if (responseIsServing(response, body)) return true;
      } catch (_error) {}
      await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  async function start(options = {}) {
    if (!enabled) return status();
    if (!options.scheduled) shutDown = false;
    if (child && state === 'ready') return status();
    if (startPromise || child) {
      throw createSupervisorError('go_core_start_in_progress', 'Go Core 正在启动，禁止重复拉起');
    }
    try {
      return await launch(options);
    } catch (error) {
      logStartFailure(error);
      scheduleRestart();
      throw error;
    }
  }

  function logStartFailure(error) {
    const code = String(error && (error.code || error.message) || 'go_core_failed');
    const at = now();
    if (code === lastLoggedFailure.code && at - lastLoggedFailure.at < FAILURE_LOG_INTERVAL_MS) return;
    lastLoggedFailure = { code, at };
    const hint = /build_(mismatch|unverified)|binary_missing/.test(code) ? ' (run: npm run go:build)' : '';
    logSink.write('supervisor', `Go Core start failed: ${code}${hint}; retrying with backoff`);
  }

  async function launch(options) {
    const invocation = buildGoCoreInvocation({
      ...deps,
      ...options,
      path: pathImpl,
      baseEnv: processObj.env,
    });
    if (!fs.existsSync(invocation.command)) {
      throw createSupervisorError('go_core_binary_missing', `Go Core 构件不存在: ${invocation.command}`);
    }
    if (deps.verifyBuild !== false) {
      const repositoryRoot = resolveRepositoryRoot({ ...deps, path: pathImpl });
      const verified = verifyBuildStamp(fs, {
        binaryPath: invocation.command,
        expectedVersion: readPackageVersion(fs, repositoryRoot, pathImpl),
        expectedRouteManifestHash: computeRouteManifestHash(fs, repositoryRoot, pathImpl)
      });
      if (!verified.ok) {
        lastError = createSupervisorError(verified.code, `Go Core 构件校验失败: ${verified.detail}`);
        state = 'failed';
        throw lastError;
      }
    }
    state = 'starting';
    lastError = null;
    currentEndpoint = invocation.endpoint;
    stopping = false;
    childExited = false;
    startPromise = (async () => {
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: pathImpl.dirname(invocation.command),
          env: invocation.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        attachLifecycle(child);
        pipeOutput(child);
        if (!(await waitForServing(invocation.endpoint, Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS))) {
          await stop({ timeoutMs: options.stopTimeoutMs, internal: true });
          throw createSupervisorError('go_core_not_ready', 'Go Core 未在门限内 ready');
        }
        state = 'ready';
        readyAt = now();
        return status();
      } catch (error) {
        if (state !== 'stopped') state = 'failed';
        lastError = error;
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function stop(options = {}) {
    if (!options.internal) shutDown = true;
    if (restartTimer) {
      clearTimer(restartTimer);
      restartTimer = null;
    }
    const processHandle = child;
    if (!processHandle) {
      if (state !== 'disabled') state = 'stopped';
      return status();
    }
    stopping = true;
    child = null;
    state = 'stopping';
    try { processHandle.kill('SIGTERM'); } catch (_error) {}
    const deadline = Date.now() + (Number(options.timeoutMs) || DEFAULT_STOP_TIMEOUT_MS);
    while (!childExited && Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    if (!childExited && typeof processObj.kill === 'function' && Number(processHandle.pid) > 0) {
      try { processObj.kill(Number(processHandle.pid), 'SIGKILL'); } catch (_error) {}
    }
    state = 'stopped';
    stopping = false;
    return status();
  }

  return { buildInvocation: buildGoCoreInvocation, start, stop, status };
}

module.exports = {
  DEFAULT_GO_CORE_HOST,
  DEFAULT_GO_CORE_PORT,
  DEFAULT_PUBLIC_PORT,
  buildGoCoreInvocation,
  createGoCoreSupervisor,
  resolveGoServerBinary,
  validatePrivateEndpoint,
};
