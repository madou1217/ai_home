'use strict';

// Plugin Host 子进程的监督者（Node 公开宿主侧）。
//
// - 环境变量按白名单构造：插件宿主拿不到网关的 API Key、管理密钥与账号凭据（ADR-P2：不默认暴露全部环境与凭据）。
// - 就绪以子进程 stdout 的 plugin_host_ready 事件为准，再完成 RPC 握手；不轮询重连。
// - 宿主进程退出会让所有在途调用以 plugin_rpc_closed 失败，并记录退出码/信号与 stderr 尾部用于诊断。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRpcClient } = require('../transport/rpc-client');
const { resolvePluginSocket } = require('../transport/address');
const { PluginError } = require('../sdk/errors');

const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'
]);
const STDERR_TAIL_BYTES = 8192;

function buildHostEnvironment(source, extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return { ...env, ...extra };
}

function createPluginHostSupervisor(options = {}) {
  const aiHomeDir = path.resolve(String(options.aiHomeDir || ''));
  const socketPath = options.socketPath || resolvePluginSocket(aiHomeDir);
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const entry = options.entry || path.join(__dirname, 'host-entry.mjs');
  const hooks = options.hooks || path.join(__dirname, 'register-hooks.mjs');
  const nodePath = options.nodePath || process.execPath;
  const startTimeoutMs = Number(options.startTimeoutMs || 10000);
  let child = null;
  let client = null;
  let starting = null;
  let lastExit = null;
  let stderrTail = '';

  function environment() {
    return buildHostEnvironment(options.env || process.env, {
      AIH_PLUGIN_SOCKET: socketPath,
      AIH_PLUGIN_TOKEN_FROM_STDIN: '1',
      AIH_PLUGIN_HOST_VERSION: String(options.hostVersion || '1.0.0'),
      AIH_PLUGIN_EXIT_WITH_PARENT: '1',
      ...(options.debug ? { AIH_PLUGIN_DEBUG: '1' } : {})
    });
  }

  function waitForReady(processHandle) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new PluginError('plugin_host_start_timeout', stderrTail.trim())), startTimeoutMs);
      processHandle.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        if (buffer.includes('"plugin_host_ready"')) { clearTimeout(timer); resolve(); }
      });
      processHandle.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new PluginError('plugin_host_exited', `宿主启动即退出 code=${code} signal=${signal} ${stderrTail.trim()}`));
      });
    });
  }

  async function launch() {
    if (process.platform !== 'win32' && !options.socketPath) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    }
    stderrTail = '';
    // --import 只接受 URL：Windows 上 C:\... 会被当成 c: 协议直接拒绝（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
    const nodeArgs = Array.isArray(options.nodeArgs) ? options.nodeArgs.map(String) : [];
    const processHandle = spawn(nodePath, [...nodeArgs, '--import', pathToFileURL(hooks).href, entry], {
      // stdin 管道：第一行交付 RPC 令牌（不进环境块），之后保持打开，宿主据其 EOF 感知父进程退出。
      env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    child = processHandle;
    processHandle.stdin.on('error', () => {});
    processHandle.stdin.write(`${token}\n`);
    processHandle.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
      options.onLog?.(String(chunk));
    });
    processHandle.once('exit', (code, signal) => {
      lastExit = { code, signal, at: Date.now(), stderr: stderrTail.slice(-2048) };
      if (child === processHandle) child = null;
      client?.close(new PluginError('plugin_rpc_closed', `插件宿主已退出 code=${code} signal=${signal}`));
      client = null;
      options.onExit?.(lastExit);
    });
    await waitForReady(processHandle);
    const nextClient = createRpcClient({ socketPath, token, connectTimeoutMs: 3000 });
    await nextClient.connect();
    client = nextClient;
    return client;
  }

  async function start() {
    if (client && child) return client;
    if (!starting) {
      starting = launch().catch(async (error) => {
        await stop();
        throw error;
      }).finally(() => { starting = null; });
    }
    return starting;
  }

  async function stop() {
    const handle = child;
    if (client) {
      try { await client.call('shutdown', {}, { timeoutMs: 3000 }); } catch (_error) {}
      client.close();
      client = null;
    }
    if (handle && handle.exitCode === null && handle.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { handle.kill('SIGKILL'); } catch (_error) {} resolve(); }, 3000);
        handle.once('exit', () => { clearTimeout(timer); resolve(); });
        try { handle.kill('SIGTERM'); } catch (_error) { clearTimeout(timer); resolve(); }
      });
    }
    child = null;
  }

  function status() {
    return { running: Boolean(child && client), pid: child?.pid || 0, socketPath, lastExit };
  }

  return {
    start,
    stop,
    restart: async () => { await stop(); return start(); },
    status,
    socketPath,
    // Go 数据面直连同一个宿主所需的地址与令牌；只经 Go 管理接口传递，不进 env 或日志。
    access: () => ({ address: socketPath, token }),
    call: async (method, value, callOptions) => (await start()).call(method, value, callOptions)
  };
}

module.exports = { createPluginHostSupervisor, buildHostEnvironment, ENV_ALLOWLIST };
