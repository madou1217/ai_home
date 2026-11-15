'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

function resolveResumeProxyBinary(options, env) {
  const standard = resolveGoServerBinary({ binaryPath: options.goServerBinary || env.AIH_GO_CORE_BINARY });
  const explicit = Boolean(options.goServerBinary || env.AIH_GO_CORE_BINARY);
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-resume-proxy.exe' : 'aih-codex-resume-proxy');
  for (const candidate of explicit ? [standard] : [standard, companion]) {
    if (!fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['__codex-resume-proxy', '--capabilities'], withHiddenWindowsConsole({ env, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 }));
    if (result.status === 0 && result.stdout.trim() === 'aih-codex-resume-proxy-v1') return candidate;
  }
  throw new Error('codex_resume_native_binary_missing_or_outdated');
}

function startNativeCodexResumeProxy(remote, options = {}) {
  const remoteUrl = String(remote && remote.remoteUrl || '').trim();
  const cwd = String(options.cwd || '').trim();
  if (!remoteUrl) return Promise.reject(new Error('missing_remote_url'));
  if (!cwd) return Promise.reject(new Error('missing_resume_cwd'));
  const env = options.env || process.env;
  let binary;
  try { binary = resolveResumeProxyBinary(options, env); } catch (error) { return Promise.reject(error); }
  const authToken = crypto.randomBytes(32).toString('hex');
  const input = JSON.stringify({ remoteUrl, cwd, authToken: String(remote.authToken || ''), localToken: authToken }) + '\n';
  if (Buffer.byteLength(input) > 32 * 1024) return Promise.reject(new Error('resume_proxy_config_too_large'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, ['__codex-resume-proxy', '--host', options.host || '127.0.0.1', '--parent-pid', String(process.pid)], withHiddenWindowsConsole({env,stdio:['pipe','pipe','pipe']})); }
    catch (error) { reject(error); return; }
    let settled = false;
    let output = '';
    let stopping = false;
    let forceTimer;
    const close = () => {
      if (stopping) return;
      stopping = true;
      try { child.kill('SIGTERM'); } catch (_error) {}
      forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_error) {} }, 3500);
      forceTimer.unref();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('resume_proxy_ready_timeout')), 5000);
    child.once('error', () => fail(new Error('resume_proxy_spawn_failed')));
    child.once('exit', (code) => {
      clearTimeout(forceTimer);
      if (settled) return;
      stopping = true;
      fail(new Error(`resume_proxy_exited_before_ready:${code}`));
    });
    child.stdin.once('error', () => fail(new Error('resume_proxy_config_pipe_failed')));
    // Do not log child stderr: a native upstream error may contain endpoint info.
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > 16 * 1024) { fail(new Error('resume_proxy_ready_invalid')); return; }
      const index = output.indexOf('\n');
      if (index < 0) return;
      let ready;
      try { ready = JSON.parse(output.slice(0, index)); } catch (_error) { fail(new Error('resume_proxy_ready_invalid')); return; }
      const port = Number(ready.port);
      if (!ready.ok || !Number.isInteger(port) || port <= 0 || port > 65535) { fail(new Error('resume_proxy_ready_invalid')); return; }
      settled = true;
      output = '';
      clearTimeout(timer);
      resolve({ remoteUrl: `ws://${ready.host === '::1' ? '[::1]' : ready.host}:${port}`, authToken, close, child });
    });
    child.stdin.end(input);
  });
}

module.exports = { startNativeCodexResumeProxy };
