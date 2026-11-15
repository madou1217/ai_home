'use strict';

const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');

const VALUE_FLAGS = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval', '-i', '--image', '-o', '--output-last-message', '--output-schema', '--color', '--thread-source', '--cyber-access-program']);

// Only recognition belongs here; resolution/policy/official RPC lives in Go.
function isExecResume(args) {
  let stage = 0;
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i]);
    if (token === '--') return stage === 2;
    if (['--help', '-h', '--version', '-V'].includes(token)) return false;
    const flag = token.split('=', 1)[0];
    if (['--remote', '--remote-auth-token-env', '--oss', '--local-provider'].includes(flag)) return false;
    if (VALUE_FLAGS.has(token)) { i += 1; continue; }
    if (token.startsWith('-')) continue;
    if (stage === 0) { if (token !== 'exec' && token !== 'e') return false; stage = 1; }
    else if (stage === 1) { if (token !== 'resume') return false; stage = 2; }
  }
  return stage === 2;
}

async function prepareExecResume(command, args, options = {}) {
  if (!isExecResume(args)) return { args, close: async () => {} };
  const env = options.env || process.env;
  const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
  const binary = resolveGoServerBinary({ binaryPath: options.goServerBinary || env.AIH_GO_CORE_BINARY });
  if (!fs.existsSync(binary)) throw new Error('codex_exec_intent_binary_unavailable');
  const probe = spawnSync(binary, ['__codex-exec-intent', '--capabilities'], withHiddenWindowsConsole({ env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }));
  if (probe.status !== 0 || String(probe.stdout).trim() !== 'aih-codex-exec-intent-v1') throw new Error('codex_exec_intent_binary_outdated');
  const target = resolveWindowsUpstreamSpawn(command, [], { platform: options.platform || process.platform, env });
  if (target.windowsVerbatimArguments) throw new Error('codex_exec_intent_requires_native_or_node_launcher');
  const launchEnv = { ...env, ...target.envPatch };
  const config = JSON.stringify({ command: target.command, prefix: target.args, args, windowsVerbatim: false }) + '\n';
  if (Buffer.byteLength(config) > 256 * 1024) throw new Error('codex_exec_intent_config_too_large');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['__codex-exec-intent', '--parent-pid', String(process.pid)], withHiddenWindowsConsole({ env: launchEnv, cwd: options.cwd || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }));
    let output = '', diagnostic = '', settled = false, closing = false;
    let reportLost;
    const lost = new Promise(resolveLost => { reportLost = resolveLost; });
    let done;
    const exited = new Promise(resolveExit => { done = resolveExit; });
    child.once('exit', done);
    child.once('error', done);
    const close = async () => {
      if (!closing && child.exitCode === null) { closing = true; child.stdin.end(); }
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 2000); timer.unref();
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 4000); force.unref();
      await exited; clearTimeout(timer); clearTimeout(force);
    };
    const fail = message => { if (!settled) { settled = true; clearTimeout(timeout); void close(); reject(new Error(message)); } };
    const timeout = setTimeout(() => fail('codex_exec_intent_timeout'), 18000);
    child.once('error', () => {
      if (settled && !closing) reportLost(new Error('codex_exec_intent_lease_lost'));
      else fail('codex_exec_intent_spawn_failed');
    });
    child.once('exit', () => {
      if (settled && !closing) reportLost(new Error('codex_exec_intent_lease_lost'));
      else fail(diagnostic.trim() || 'codex_exec_intent_failed');
    });
    child.stdin.once('error', () => fail('codex_exec_intent_pipe_failed'));
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2048); });
    child.stdout.on('data', chunk => {
      if (settled) return;
      output += String(chunk);
      if (Buffer.byteLength(output) > 256 * 1024) return fail('codex_exec_intent_reply_too_large');
      const end = output.indexOf('\n'); if (end < 0) return;
      let result; try { result = JSON.parse(output.slice(0, end)); } catch (_) { return fail('codex_exec_intent_reply_invalid'); }
      if (!result.ok || !Array.isArray(result.args) || result.args.some(arg => typeof arg !== 'string')) return fail('codex_exec_intent_reply_invalid');
      settled = true; clearTimeout(timeout); resolve({ args: result.args, close, child, lost });
    });
    child.stdin.write(config);
  });
}

function terminateWindowsExecTree(child) {
  const pid = Number(child && child.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('codex_exec_intent_process_tree_unavailable');
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], withHiddenWindowsConsole({ stdio: 'ignore', timeout: 3000 }));
  if (result.error || result.status !== 0) throw new Error('codex_exec_intent_process_tree_termination_failed');
}

module.exports = { isExecResume, prepareExecResume, terminateWindowsExecTree };
