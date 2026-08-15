'use strict';

const nodePath = require('node:path');

const DEFAULT_GO_CORE_HOST = '127.0.0.1';
const DEFAULT_GO_CORE_PORT = 19550;
const DEFAULT_PUBLIC_PORT = 9527;
const DEFAULT_READY_TIMEOUT_MS = 7000;
const DEFAULT_STOP_TIMEOUT_MS = 3000;

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
function resolveGoServerBinary(options = {}) {
  const pathImpl = options.path || nodePath;
  const explicit = nonEmpty(options.binaryPath || options.goServerBinary);
  if (explicit) return pathImpl.resolve(explicit);
  const repositoryRoot = pathImpl.resolve(
    nonEmpty(options.repositoryRoot) || pathImpl.join(__dirname, '../../../..'),
  );
  const platform = nonEmpty(options.platform || process.platform);
  const arch = nonEmpty(options.arch || process.arch);
  const directory = pathImpl.join(repositoryRoot, 'bin', 'native', `${platform}-${arch}`);
  return pathImpl.join(directory, 'aih-server');
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

function responseIsReady(response, body) {
  return Boolean(
    response && response.ok
    && body && body.service === 'aih-server'
    && body.ready === true,
  );
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
  let child = null;
  let state = enabled ? 'stopped' : 'disabled';
  let lastError = null;
  let currentEndpoint = null;
  let stopping = false;
  let startPromise = null;
  let childExited = false;

  function status() {
    return {
      enabled,
      state,
      pid: child && Number(child.pid) > 0 ? Number(child.pid) : 0,
      endpoint: currentEndpoint ? `http://${currentEndpoint.host}:${currentEndpoint.port}` : '',
      error: lastError ? lastError.code || 'go_core_failed' : '',
    };
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
    });
  }

  async function waitForReady(endpoint, clientKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!child || state === 'failed') return false;
      try {
        const response = await fetchImpl(
          `http://${endpoint.host}:${endpoint.port}/readyz`,
          { headers: { authorization: `Bearer ${clientKey}` } },
        );
        let body = null;
        if (typeof response.json === 'function') body = await response.json();
        if (responseIsReady(response, body)) return true;
      } catch (_error) {}
      await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  async function start(options = {}) {
    if (!enabled) return status();
    if (child && state === 'ready') return status();
    if (startPromise || child) {
      throw createSupervisorError('go_core_start_in_progress', 'Go Core 正在启动，禁止重复拉起');
    }
    const invocation = buildGoCoreInvocation({
      ...deps,
      ...options,
      path: pathImpl,
      baseEnv: processObj.env,
    });
    if (!fs.existsSync(invocation.command)) {
      throw createSupervisorError('go_core_binary_missing', `Go Core 构件不存在: ${invocation.command}`);
    }
    const clientKey = nonEmpty(resolveValue(options.clientKey || deps.clientKey));
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
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        attachLifecycle(child);
        if (!(await waitForReady(invocation.endpoint, clientKey, Number(options.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS))) {
          await stop({ timeoutMs: options.stopTimeoutMs });
          throw createSupervisorError('go_core_not_ready', 'Go Core 未在门限内 ready');
        }
        state = 'ready';
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
