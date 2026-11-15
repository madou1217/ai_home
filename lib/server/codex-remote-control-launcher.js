'use strict';

// Compatibility launch port only. The transport, protocol rewrite, diagnostic
// budgets and parent-death lifetime are owned by the native Go subcommand.
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

function waitForReadyFile(fs, filePath, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      const info = fs.statSync(filePath);
      if (info.isFile() && info.size <= 16 * 1024) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data && typeof data === 'object') return data;
      }
    } catch (_error) {}
    Atomics.wait(wait, 0, 0, 25);
  }
  return null;
}

function startRemoteControlProxyProcess(fs, state, writeTrace, deps = {}) {
  if (state.remoteControlProxy === false) return null;
  const processObj = deps.processObj || process;
  const env = processObj.env || process.env;
  const standard = resolveGoServerBinary({ binaryPath: deps.goServerBinary || env.AIH_GO_CORE_BINARY, platform: processObj.platform || process.platform, arch: processObj.arch || process.arch });
  const explicit = Boolean(deps.goServerBinary || env.AIH_GO_CORE_BINARY);
  // Development can stage this isolated helper without replacing/restarting the
  // shared gateway. Release packages use the standard native server directly.
  const companion = path.join(path.dirname(standard), (processObj.platform || process.platform) === 'win32' ? 'aih-codex-remote-control.exe' : 'aih-codex-remote-control');
  let binary = '';
  for (const candidate of explicit ? [standard] : [standard, companion]) {
    if (!fs.existsSync(candidate)) continue;
    const capabilities = childProcess.spawnSync(candidate, ['__codex-remote-control', '--capabilities'], withHiddenWindowsConsole({ encoding: 'utf8', env, timeout: 5000, maxBuffer: 16 * 1024 }));
    if (capabilities.status === 0 && String(capabilities.stdout || '').trim() === 'aih-codex-remote-control-v1') { binary = candidate; break; }
  }
  if (!binary) throw new Error(fs.existsSync(standard) ? 'codex_remote_control_native_binary_outdated' : 'codex_remote_control_native_binary_missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-remote-control-'));
  fs.chmodSync(dir, 0o700);
  const readyFile = path.join(dir, 'ready.json');
  const suppressStateFile = path.join(dir, 'suppress.json');
  fs.writeFileSync(suppressStateFile, '{"threads":[]}\n', { mode: 0o600 });
  const args = ['__codex-remote-control', '--host', '127.0.0.1', '--port', '0', '--ready-file', readyFile, '--suppress-state-file', suppressStateFile, '--parent-pid', String(processObj.pid || process.pid)];
  if (state.traceFile) args.push('--trace-file', state.traceFile);
  if (deps.upstreamOrigin) args.push('--upstream-origin', deps.upstreamOrigin);
  const cleanup = () => {
    try { fs.rmSync(readyFile, { force: true }); } catch (_error) {}
    try { fs.rmSync(suppressStateFile, { force: true }); } catch (_error) {}
    try { fs.rmdirSync(dir); } catch (_error) {}
  };
  let child;
  try {
    child = (deps.spawn || childProcess.spawn)(binary, args, withHiddenWindowsConsole({stdio:['ignore','ignore','pipe'],env,detached:false}));
  } catch (error) { cleanup(); throw error; }
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-4096); });
  child.once('error', cleanup);
  child.once('exit', cleanup);
  const ready = waitForReadyFile(fs, readyFile, Number(deps.readyTimeoutMs) || 2500);
  try { fs.rmSync(readyFile, { force: true }); } catch (_error) {}
  const port = Number(ready && ready.port);
  if (!ready || ready.ok !== true || !Number.isInteger(port) || port <= 0 || port > 65535) {
    try { child.kill('SIGTERM'); } catch (_error) {}
    cleanup();
    writeTrace({ direction:'proxy_internal', action:'remote_control_proxy_not_ready', native:true });
    // Never silently bypass an enabled proxy or revive the old Node owner.
    throw new Error(`codex_remote_control_native_not_ready${stderr ? ': child exited before ready' : ''}`);
  }
  const baseUrl = `http://127.0.0.1:${port}/backend-api`;
  writeTrace({direction:'proxy_internal',action:'remote_control_proxy_ready',native:true,baseUrl});
  return {child,baseUrl,suppressStateFile};
}

module.exports = { waitForReadyFile, startRemoteControlProxyProcess };
