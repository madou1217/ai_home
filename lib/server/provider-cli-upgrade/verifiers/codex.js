'use strict';

// codex 的强判据：拿一次性沙箱把 app-server 真起一次。
//
// 为什么需要它：2026-09-13 的事故里，坏版本的 `codex --version` 完全正常，
// 失败发生在 app-server 启动时拒绝加载配置：
//   Error: error loading default config after config error:
//   model_providers.aih_server: provider name must not be empty
// 该形态已在 macOS 与真实 Windows 双端复现过，是这条判据的设计依据。
//
// 先跑 healAppServerProviderConfig 自愈再起，确保测的是「新版本能不能跑」，
// 而不是「配置有没有被同步过」——否则会把配置问题误判成版本问题然后无谓回滚。
//
// 只用一次性 CODEX_HOME，绝不碰用户真实的 ~/.codex。

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');

const { healAppServerProviderConfig } = require('../../codex-app-server-config-heal');

const VERDICTS = Object.freeze({ PASS: 'pass', FAIL: 'fail', INCONCLUSIVE: 'inconclusive' });
const DEFAULT_TIMEOUT_MS = 15_000;
const READY_PATTERN = /listening on:/i;
// 配置类拒绝的签名。命中即判正向失败，其余退出一律按 inconclusive 处理。
const CONFIG_REJECT_PATTERN = /error loading .*config|config error|must not be empty|invalid .*config|failed to parse/i;

function makeSandbox(fsImpl, osImpl, pathImpl) {
  const home = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'aih-codex-verify-'));
  const codexHome = pathImpl.join(home, '.codex');
  fsImpl.mkdirSync(codexHome, { recursive: true });
  fsImpl.writeFileSync(pathImpl.join(codexHome, 'config.toml'), 'personality = "pragmatic"\n');
  return { home, codexHome };
}

async function verifyCodexAppServerBoot(context = {}) {
  const fsImpl = context.fs || nodeFs;
  const osImpl = context.os || nodeOs;
  const pathImpl = context.path || nodePath;
  const spawnImpl = context.spawn || spawn;
  const timeoutMs = Number(context.verifyTimeoutMs) || DEFAULT_TIMEOUT_MS;

  let sandbox;
  try {
    sandbox = makeSandbox(fsImpl, osImpl, pathImpl);
  } catch (error) {
    return { verdict: VERDICTS.INCONCLUSIVE, detail: `sandbox_failed:${error && error.message}` };
  }

  const cleanup = () => {
    try { fsImpl.rmSync(sandbox.home, { recursive: true, force: true }); } catch (_error) { /* 清理失败不影响结论 */ }
  };

  try {
    // 先自愈，再启动：受管 provider 段缺 name 正是 0.154 拒绝加载配置的原因。
    healAppServerProviderConfig({
      env: { CODEX_HOME: sandbox.codexHome, OPENAI_API_KEY: 'aih-verify', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' },
      providerArgs: ['-c', 'model_provider=aih_server'],
      runtimeDir: sandbox.home,
      fs: fsImpl
    });
  } catch (error) {
    cleanup();
    return { verdict: VERDICTS.INCONCLUSIVE, detail: `heal_failed:${error && error.message}` };
  }

  const port = Number(context.probePort) || 0;
  const args = [
    'app-server',
    '-c', 'model_provider=aih_server',
    '-c', 'model_providers.aih_server.base_url=http://127.0.0.1:1/v1',
    '-c', 'model_providers.aih_server.wire_api=responses',
    '--listen', `ws://127.0.0.1:${port || 0}`
  ];

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let output = '';
    const finish = (verdict, detail) => {
      if (settled) return;
      settled = true;
      try { if (child && !child.killed) child.kill('SIGKILL'); } catch (_error) { /* ignore */ }
      clearTimeout(timer);
      cleanup();
      resolve({ verdict, detail });
    };

    const timer = setTimeout(() => {
      // 进程活到超时说明配置被接受、二进制起得来。没看到 banner 也不构成失败信号。
      finish(output.match(READY_PATTERN) ? VERDICTS.PASS : VERDICTS.INCONCLUSIVE, 'timeout_without_exit');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      child = spawnImpl(context.cliPath || 'codex', args, {
        env: {
          ...process.env,
          CODEX_HOME: sandbox.codexHome,
          OPENAI_API_KEY: 'aih-verify',
          OPENAI_BASE_URL: 'http://127.0.0.1:1/v1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      finish(VERDICTS.INCONCLUSIVE, `spawn_failed:${error && error.message}`);
      return;
    }

    const absorb = (chunk) => {
      output += String(chunk || '');
      if (READY_PATTERN.test(output)) finish(VERDICTS.PASS, 'app_server_listening');
    };
    if (child.stdout) child.stdout.on('data', absorb);
    if (child.stderr) child.stderr.on('data', absorb);
    child.on('error', (error) => finish(VERDICTS.INCONCLUSIVE, `child_error:${error && error.message}`));
    child.on('close', () => {
      if (READY_PATTERN.test(output)) { finish(VERDICTS.PASS, 'app_server_listening'); return; }
      // 握手前就退出，且带配置类拒绝签名 → 正向失败信号，可以据此回滚。
      const detail = output.split('\n').find((line) => CONFIG_REJECT_PATTERN.test(line)) || '';
      finish(detail ? VERDICTS.FAIL : VERDICTS.INCONCLUSIVE, detail.trim().slice(0, 300) || 'exited_without_signature');
    });
  });
}

module.exports = { VERDICTS, verifyCodexAppServerBoot };
