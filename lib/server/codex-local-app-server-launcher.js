'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const { resolveCodexSessionListScope } = require('./codex-session-list-scope');
const { REMOTE_AUTH_TOKEN_ENV, extractAppServerConfigArgs } = require('./codex-tui-local-policy');

function resolveBinary(options, env) {
  const standard = resolveGoServerBinary({ binaryPath: options.goServerBinary || env.AIH_GO_CORE_BINARY });
  const explicit = Boolean(options.goServerBinary || env.AIH_GO_CORE_BINARY);
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-local-app-server.exe' : 'aih-codex-local-app-server');
  for (const binary of explicit ? [standard] : [standard, companion]) {
    if (!fs.existsSync(binary)) continue;
    const result = spawnSync(binary, ['__codex-local-app-server', '--capabilities'], withHiddenWindowsConsole({env, encoding:'utf8',timeout:5000,maxBuffer:16384}));
    if (result.status === 0 && result.stdout.trim() === 'aih-codex-local-app-server-v1') return binary;
  }
  throw new Error('codex_local_native_binary_missing_or_outdated');
}

function startNativeLocalAppServer(options = {}) {
  const upstream = String(options.upstream || '').trim();
  const scope = resolveCodexSessionListScope(options.args, options.cwd);
  if (!upstream || !scope.cwd) return Promise.reject(new Error('codex_tui_local_app_server_invalid_options'));
  const env = { ...(options.env || {}) };
  delete env[REMOTE_AUTH_TOKEN_ENV];
  delete env.AIH_CODEX_REMOTE_AUTH_TOKEN;
  let binary, target;
  try {
    binary = resolveBinary(options, env);
    target = resolveWindowsUpstreamSpawn(upstream, ['app-server', ...extractAppServerConfigArgs(options.args), '--listen', 'stdio://'], { platform: options.platform || process.platform, env });
  } catch (error) { return Promise.reject(error); }
  const authToken = crypto.randomBytes(32).toString('hex');
  const config = JSON.stringify({ command: target.command, args: target.args, cwd: scope.cwd, authToken, injectCwd: options.injectCwd !== false && scope.injectCwd, windowsVerbatim: target.windowsVerbatimArguments === true }) + '\n';
  if (Buffer.byteLength(config) > 256 * 1024) return Promise.reject(new Error('codex_local_config_too_large'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, ['__codex-local-app-server', '--parent-pid', String(process.pid)], withHiddenWindowsConsole({ env: {...env,...target.envPatch}, cwd: scope.cwd, stdio:['pipe','pipe','pipe'] })); }
    catch (error) { reject(error); return; }
    let settled = false, closing = false, output = '', force;
    let resolveExit;
    const exited = new Promise((done) => { resolveExit = done; });
    const close = () => {
      if (!closing && child.exitCode === null) {
        closing = true;
        try { child.kill('SIGTERM'); } catch (_error) {}
        force = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_error) {} }, 4000);
        force.unref();
      }
      return exited;
    };
    const fail = (error) => { if (!settled) { settled=true;clearTimeout(timer);void close();reject(error); } };
    const timer = setTimeout(() => fail(new Error('codex_local_ready_timeout')), 5000);
    child.once('error', () => { resolveExit();fail(new Error('codex_local_spawn_failed')); });
    child.once('exit', (code) => { clearTimeout(force);closing=true;resolveExit();fail(new Error(`codex_local_exited_before_ready:${code}`)); });
    child.stdin.once('error', () => fail(new Error('codex_local_config_pipe_failed')));
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      output += String(chunk);
      if (Buffer.byteLength(output)>16384) {fail(new Error('codex_local_ready_invalid'));return;}
      const end=output.indexOf('\n');if(end<0)return;
      let ready;try {ready=JSON.parse(output.slice(0,end));}catch(_error){fail(new Error('codex_local_ready_invalid'));return;}
      if(!ready.ok || ready.host!=='127.0.0.1' || !Number.isInteger(ready.port) || ready.port<1 || ready.port>65535){fail(new Error('codex_local_ready_invalid'));return;}
      settled=true;output='';clearTimeout(timer);
      resolve({ remoteUrl:`ws://127.0.0.1:${ready.port}`,authToken,tokenEnv:REMOTE_AUTH_TOKEN_ENV,close,child });
    });
    child.stdin.end(config);
  });
}

module.exports = { startNativeLocalAppServer };
