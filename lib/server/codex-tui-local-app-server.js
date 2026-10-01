'use strict';

// 交互式 codex TUI 的本地 app-server 代理：让终端里的 /resume 列出当前项目的全部会话。
//
// codex TUI 默认用进程内 app-server，/resume 只列与当前 model_provider 相同的会话：
// 直接用账号启动（openai）与 aih codex（aih_server）看不到彼此的会话，codex 也没有关闭
// 这个过滤的开关（实测：thread/list 的 modelProviders 省略或为 [当前] 时只列当前 provider，
// 为 [] 时才列全部；只改 state DB 的 model_provider 不够，codex 以 rollout 头为准）。
//
// 做法：TUI 以 --remote 连本地代理，代理为每个连接用**调用方自己的环境与配置**拉起
// `codex app-server --listen stdio://`（provider、账号、hooks 与进程内模式完全一致），
// 转发时复用共享会话的改写：thread/list 注入当前目录、modelProviders 置 []。
// 不复用网关 /v0/codex/app-server：那里按宿主默认账号起 app-server，会把会话跑到别的账号上。
//
// 监听只在 127.0.0.1，且要求每次启动随机生成的令牌（该 app-server 可能是完全访问权限）。
//
// Windows：上游可能是 npm .cmd 垫片（直接 spawn 会 EINVAL），按 resolveWindowsUpstreamSpawn 解析；
// child.kill 只结束直接子进程（cmd→node 链的孙进程会残留并攥着线程写锁），结束时用 taskkill /T /F 收整棵树。

const crypto = require('node:crypto');
const { spawn: defaultSpawn, spawnSync: defaultSpawnSync } = require('node:child_process');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const WebSocket = require('ws');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const {
  rememberThreadResumeRequestMessage,
  patchThreadResumeResponseMessage
} = require('./codex-thread-resume-response-patch');

const REMOTE_AUTH_TOKEN_ENV = 'AIH_CODEX_LOCAL_REMOTE_TOKEN';
// 需要传给 app-server 的配置类参数（决定 provider / 模型 / profile / feature）；其余参数只给 TUI。
const CONFIG_FLAGS_WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '--enable', '--disable']);

function extractAppServerConfigArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '');
    if (token === '--') break;
    if (CONFIG_FLAGS_WITH_VALUE.has(token) && index + 1 < list.length) {
      out.push(token, String(list[index + 1]));
      index += 1;
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0 && CONFIG_FLAGS_WITH_VALUE.has(token.slice(0, eq)) && token.startsWith('--')) out.push(token);
  }
  return out;
}

function isAuthorized(request, token) {
  const header = String(request && request.headers && request.headers.authorization || '').trim();
  const expected = `Bearer ${token}`;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function terminateChild(child, options = {}) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  if (options.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      (options.spawnSync || defaultSpawnSync)('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return;
    } catch (_error) {}
  }
  try { child.kill('SIGTERM'); } catch (_error) {}
}

function bridgeConnection(client, child, cwd, onClose, terminate) {
  const responseContexts = new Map();
  let stdoutBuffer = '';
  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { client.close(); } catch (_error) {}
    terminate(child);
    onClose();
  };

  client.on('message', (data) => {
    const rewritten = rewriteCodexAppServerClientMessage(data, { cwd });
    rememberThreadResumeRequestMessage(rewritten, responseContexts);
    try { child.stdin.write(`${rewritten}\n`); } catch (_error) { closeAll(); }
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim() && client.readyState === WebSocket.OPEN) {
        client.send(patchThreadResumeResponseMessage(line, responseContexts));
      }
      newline = stdoutBuffer.indexOf('\n');
    }
  });
  client.on('close', closeAll);
  client.on('error', closeAll);
  child.on('exit', closeAll);
  child.on('error', closeAll);
}

/**
 * @param {{upstream: string, env: object, args: string[], cwd: string, spawn?: Function}} options
 * @returns {Promise<{remoteUrl: string, authToken: string, tokenEnv: string, close: () => Promise<void>}>}
 */
function startCodexTuiLocalAppServer(options = {}) {
  const upstream = String(options.upstream || '').trim();
  const cwd = String(options.cwd || '').trim();
  if (!upstream || !cwd) return Promise.reject(new Error('codex_tui_local_app_server_invalid_options'));
  const spawnImpl = options.spawn || defaultSpawn;
  const platform = String(options.platform || process.platform);
  const terminate = (child) => terminateChild(child, { platform, spawnSync: options.spawnSync });
  const env = { ...(options.env || {}) };
  delete env[REMOTE_AUTH_TOKEN_ENV];
  const appServerArgs = ['app-server', ...extractAppServerConfigArgs(options.args), '--listen', 'stdio://'];
  const token = crypto.randomBytes(24).toString('hex');
  const children = new Set();

  return new Promise((resolve, reject) => {
    const server = new WebSocket.Server({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info) => isAuthorized(info.req, token)
    });
    server.on('connection', (client) => {
      const target = resolveWindowsUpstreamSpawn(upstream, appServerArgs, { platform, env });
      const child = spawnImpl(target.command, target.args, {
        cwd,
        env: { ...env, ...target.envPatch },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments === true
      });
      children.add(child);
      bridgeConnection(client, child, cwd, () => children.delete(child), terminate);
    });
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      resolve({
        remoteUrl: `ws://127.0.0.1:${port}`,
        authToken: token,
        tokenEnv: REMOTE_AUTH_TOKEN_ENV,
        close: () => new Promise((done) => {
          for (const child of children) terminate(child);
          children.clear();
          // server.close 会等所有连接断开；主动断开客户端，不依赖子进程退出事件。
          for (const client of server.clients) {
            try { client.terminate(); } catch (_error) {}
          }
          server.close(() => done());
        })
      });
    });
  });
}

module.exports = {
  REMOTE_AUTH_TOKEN_ENV,
  extractAppServerConfigArgs,
  startCodexTuiLocalAppServer
};
