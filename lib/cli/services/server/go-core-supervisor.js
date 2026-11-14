'use strict';

const nodePath = require('node:path');
const { pruneDatedLogs, resolveKeepDays, rotateLogByDay, trimFileToRecentBytes } = require('../../../server/log-rotation');
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
// 优雅退出请求只占停机预算的一小段：拿不到就退回信号强杀，不拖慢停机。
const DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS = 1500;
// Go 的优雅退出端点，与 internal/transport/http/shutdownapi 的 Path 一致。
const SHUTDOWN_PATH = '/v0/management/shutdown';
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

/**
 * 校验 Go Core 的监听端点。
 *
 * 默认形态是「Node 拥有公开端口、Go 只跑私有端口」；前置门形态反之：
 * Go 绑定公开端口并接管未注册路由，Node 退到 `nodePort` 私有端口。
 * 两种形态都只允许 loopback，且两个端口必须互不相同。
 */
function validatePrivateEndpoint(options = {}) {
	const host = nonEmpty(options.host === undefined ? DEFAULT_GO_CORE_HOST : options.host);
	const port = Number(options.port === undefined ? DEFAULT_GO_CORE_PORT : options.port);
	const publicPort = Number(options.publicPort === undefined ? DEFAULT_PUBLIC_PORT : options.publicPort);
	const frontDoor = options.frontDoor === true;
	if (!isLoopbackHost(host)) {
		throw createSupervisorError('go_core_endpoint_not_private', 'Go Core endpoint 必须绑定 loopback');
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw createSupervisorError('go_core_endpoint_invalid', 'Go Core endpoint 端口无效');
	}
	if (frontDoor) {
		// 前置门模式下 Go 接管公开端口：核心端口以公开端口为准，
		// 配置里遗留的私有 core 端口不再生效（否则 Node 会把公开口让出去却没人生成监听）。
		if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
			throw createSupervisorError('go_core_front_door_public_port_invalid', '前置门模式下公开端口无效');
		}
		const nodePort = Number(options.nodePort);
		if (!Number.isInteger(nodePort) || nodePort < 1 || nodePort > 65535 || nodePort === publicPort) {
			throw createSupervisorError('go_core_front_door_node_port_invalid', '前置门模式下 Node 私有端口无效');
		}
		return { host, port: publicPort, publicPort, frontDoor, nodePort };
	}
	if (port === publicPort || port === DEFAULT_PUBLIC_PORT) {
		throw createSupervisorError('go_core_endpoint_conflicts_public', 'Go Core 不得占用公开 9527');
	}
	return { host, port, publicPort, frontDoor: false, nodePort: 0 };
}

function buildGoCoreEnvironment(options = {}, endpoint) {
  const pathImpl = options.path || nodePath;
  const nodeExecPath = nonEmpty(options.nodeExecPath)
    || nonEmpty(options.processObj && options.processObj.execPath)
    || nonEmpty(process.execPath);
  const entryFilePath = nonEmpty(options.entryFilePath)
    || pathImpl.resolve(resolveRepositoryRoot({ ...options, path: pathImpl }), 'bin', 'ai-home.js');
  const environment = {
    ...(options.baseEnv || process.env),
    ...(options.env || {}),
    AIH_HOME_DIR: nonEmpty(options.aiHomeDir),
    AIH_SERVER_HOST: endpoint.host,
    AIH_SERVER_PORT: String(endpoint.port),
    AIH_SERVER_MANAGEMENT_KEY: nonEmpty(resolveValue(options.managementKey)),
    AIH_SERVER_API_KEY: nonEmpty(resolveValue(options.clientKey)),
    ...(nodeExecPath ? { AIH_SERVER_NODE_EXEC: nodeExecPath } : {}),
    ...(entryFilePath ? { AIH_SERVER_ENTRY_FILE: entryFilePath } : {}),
  };
  // 覆盖项里值为 null 的变量从子进程环境删除（例如 Node 直连时去掉继承来的宿主代理变量）。
  for (const [name, value] of Object.entries(options.env || {})) {
    if (value === null) delete environment[name];
  }
  // Node 账号同步在跑时 Node 是唯一 OAuth 刷新者；Go 自行轮换 Refresh Token 会让 Node 的副本失效。
  if (options.delegateCredentialRefresh) environment.AIH_SERVER_CREDENTIAL_REFRESH = 'delegated';
  else delete environment.AIH_SERVER_CREDENTIAL_REFRESH;
  // 持久化配置声明 Go 承接哪些 Provider 的自定义错误规则；宿主已显式声明同名环境变量时以宿主为准
  // （含显式声明为空 = 关闭），与 resolveGoCoreSettings 的「环境变量优先」语义保持一致。
  const ruleProviders = Array.isArray(options.upstreamErrorRuleProviders) ? options.upstreamErrorRuleProviders : [];
  const rulesDeclaredByHost = Object.prototype.hasOwnProperty.call(
    options.baseEnv || process.env,
    'AIH_SERVER_UPSTREAM_ERROR_RULES'
  );
  if (!rulesDeclaredByHost && ruleProviders.length > 0) {
    environment.AIH_SERVER_UPSTREAM_ERROR_RULES = ruleProviders.join(',');
  }
  return environment;
}

function appendCodexHookArgs(args, codexHooks) {
  if (!codexHooks || typeof codexHooks !== 'object') return;
  args.push(`--enable-codex-cli-hook=${codexHooks.enableCliHook === true ? 'true' : 'false'}`);
  args.push(`--enable-codex-desktop-hook=${codexHooks.enableDesktopHook === true ? 'true' : 'false'}`);
  const cliIntervalMs = Number(codexHooks.cliSelfHealIntervalMs);
  if (Number.isFinite(cliIntervalMs) && cliIntervalMs > 0) {
    args.push('--codex-cli-hook-self-heal-interval-ms', String(Math.floor(cliIntervalMs)));
  }
  const desktopIntervalMs = Number(codexHooks.desktopSelfHealIntervalMs);
  if (Number.isFinite(desktopIntervalMs) && desktopIntervalMs > 0) {
    args.push('--codex-desktop-hook-self-heal-interval-ms', String(Math.floor(desktopIntervalMs)));
  }
  const traceFile = nonEmpty(codexHooks.traceFile);
  if (traceFile) {
    args.push('--codex-desktop-trace-file', traceFile);
  }
  if (codexHooks.traceResponses !== undefined) {
    args.push(`--codex-desktop-trace-responses=${codexHooks.traceResponses === true ? 'true' : 'false'}`);
  }
  if (codexHooks.traceRemoteControl !== undefined) {
    args.push(`--codex-desktop-trace-remote-control=${codexHooks.traceRemoteControl === true ? 'true' : 'false'}`);
  }
  if (codexHooks.remoteControlProxy !== undefined) {
    args.push(`--codex-desktop-remote-control-proxy=${codexHooks.remoteControlProxy === true ? 'true' : 'false'}`);
  }
  if (codexHooks.restartAppServerOnHookChange !== undefined) {
    args.push(
      `--codex-desktop-restart-app-server-on-hook-change=${codexHooks.restartAppServerOnHookChange === true ? 'true' : 'false'}`,
    );
  }
  const receiverUrl = nonEmpty(codexHooks.providerHookReceiverUrl);
  if (receiverUrl) {
    args.push('--codex-provider-hook-receiver-url', receiverUrl);
  }
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
  // P2 的插件实例端点由 Go 承载：Go 需要回调 Node 的内部 prepare/activate/discard。
  // 这是监督器注入的拓扑参数（不是用户开关），Node 的公开端口就是 publicPort。
	const args = ['--host', endpoint.host, '--port', String(endpoint.port)];
	if (endpoint.frontDoor) {
		// 前置门：Go 绑定公开端口，未注册的路径交回 Node 的私有端口。
		args.push('--front-door');
		args.push('--node-base-url', `http://127.0.0.1:${endpoint.nodePort}`);
	} else if (Number.isInteger(endpoint.publicPort) && endpoint.publicPort > 0 && endpoint.publicPort <= 65535) {
		args.push('--node-base-url', `http://127.0.0.1:${endpoint.publicPort}`);
	}
  appendCodexHookArgs(args, options.codexHooks);
  return {
    command,
    args,
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
 * Go Core stdout/stderr 的落盘端：追加写入 <AIH_HOME_DIR>/logs/go-core.log；跨天归档为 <file>.<日期>（默认保留 10 天），单日仍按体积裁剪。
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
        // 跨天先归档（<file>.<日期>），再按体积裁剪当天这一个文件。
        if (rotateLogByDay({ fs, path: pathImpl, file })) {
          pruneDatedLogs({ fs, path: pathImpl, file, keepDays: resolveKeepDays(process.env) });
        }
        if (typeof fs.statSync === 'function' && fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
          trimFileToRecentBytes(fs, file, maxBytes);
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
    let deadlineProbeStarted = false;
    for (;;) {
      if (!child || state === 'failed') return false;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        if (deadlineProbeStarted) return false;
        deadlineProbeStarted = true;
      }
      try {
        const response = await fetchImpl(`http://${endpoint.host}:${endpoint.port}/healthz`, {
          signal: AbortSignal.timeout(Math.min(1000, remainingMs > 0 ? remainingMs : 1000))
        });
        let body = null;
        if (typeof response.json === 'function') body = await response.json();
        if (child && state !== 'failed' && responseIsServing(response, body)) return true;
      } catch (_error) {}
      // 宿主初始化可能让在途探针超时、同时越过总门限。此时用一轮
      // 新的有界探针确认独立 Go 进程；旧请求的超时不能作为杀进程依据。
      if (deadlineProbeStarted) return false;
      if (Date.now() >= deadline) continue;
      await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
    }
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

  /**
   * 请 Go 自己走优雅关闭，而不是等信号。
   *
   * Windows 上 `child.kill('SIGTERM')` 实际是 TerminateProcess，进程内的关闭路径根本
   * 不会执行——内存里的账号运行态与用量事件每次停机都丢。这条请求走的是进程内路径，
   * 三端一致。失败只意味着退回信号强杀，不影响停机本身。
   */
  async function requestGracefulShutdown(endpoint) {
    if (!endpoint) return false;
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `http://${endpoint.host}:${endpoint.port}${SHUTDOWN_PATH}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${nonEmpty(resolveValue(deps.managementKey))}` },
          signal: controller.signal,
        },
      );
      return Boolean(response && response.ok);
    } catch (_error) {
      return false;
    } finally {
      clearTimer(timer);
    }
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
    // 只有真在服务的进程才可能响应退出请求；启动失败的进程连端口都没监听。
    const wasServing = state === 'ready';
    state = 'stopping';
    if (wasServing) await requestGracefulShutdown(currentEndpoint);
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
