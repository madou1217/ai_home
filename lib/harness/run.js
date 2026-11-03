'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
const { getExternalHarness } = require('./catalog');
const { resolveHarnessLaunchModel } = require('./alias');
const { resolvePinnedHarnessDefaultModel } = require('./pinned-default-model');
const { getHarnessAdapter } = require('./adapters');
const { readCodexGatewayConnection } = require('../server/codex-gateway-connection');
const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');

// 外部 harness 只使用网关身份：清掉宿主里可能存在的原生 Provider 凭据，
// 避免 Pi/DSH 自己发现并直连别的上游（那会绕过 aih 的账号与计费）。
const NATIVE_CREDENTIAL_ENV = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  '$OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'MOONSHOT_API_KEY',
  'Z_AI_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'PERPLEXITY_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_MODEL',
  'PI_PROVIDER'
]);

function buildExternalHarnessEnv(baseEnv, additions) {
  const env = { ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : {}) };
  for (const key of NATIVE_CREDENTIAL_ENV) delete env[key];
  return { ...env, ...(additions || {}) };
}

// 适配器可以长时间不出声（dsh-tui 首次安装 profile bundle 实测 12–24s），
// 因此允许它们上报阶段。进度是终端装饰：回调抛错绝不能打断启动。
function buildHarnessProgressNotifier(progress) {
  if (typeof progress !== 'function') return () => {};
  return (event) => {
    if (!event || !event.phase) return;
    try {
      progress(event);
    } catch (_error) {
      // 装饰失败不影响 harness 启动。
    }
  };
}

async function prepareExternalHarness(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const harness = getExternalHarness(input.harness);
  if (!harness) {
    return { ok: false, error: 'external_harness_unknown', message: `unknown external harness: ${input.harness}` };
  }
  const aiHomeDir = String(input.aiHomeDir || '').trim();
  if (!aiHomeDir) {
    return { ok: false, error: 'ai_home_dir_missing', message: 'AIH home directory is not available' };
  }
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  // 没指定模型时不能直接把池目录的第一条当默认：池级入口（如 auto）钉选后路由不到，
  // 用户看到的是 503。先按钉选账号自己的目录解析默认模型（解析不出才留空）。
  const requestedModel = String(input.model || '').trim();
  const launchModel = requestedModel || resolvePinnedHarnessDefaultModel({
    fs: fsImpl,
    aiHomeDir,
    accountRef,
    provider,
    readModelsCache: input.readModelsCache,
    readSettings: input.readSettings
  });
  const aliasResult = resolveHarnessLaunchModel({
    fs: fsImpl,
    aiHomeDir,
    provider,
    model: launchModel,
    deps: input
  });
  if (!aliasResult.ok) {
    return {
      ok: false,
      error: aliasResult.error,
      message: aliasResult.message,
      alias: aliasResult.alias
    };
  }
  const gateway = input.gateway || readCodexGatewayConnection(fsImpl, aiHomeDir, accountRef);
  if (!gateway || !gateway.baseUrl || !gateway.apiKey) {
    return { ok: false, error: 'gateway_connection_missing', message: 'AIH gateway connection is not configured' };
  }

  const common = {
    fs: fsImpl,
    path: pathImpl,
    aiHomeDir,
    hostHomeDir: input.hostHomeDir,
    accountRef,
    provider,
    model: aliasResult.model,
    gateway,
    catalog: input.catalog,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    nativeArgs: input.nativeArgs,
    env: input.env
  };

  let prepared = null;
  const adapter = getHarnessAdapter(harness.adapter);
  if (!adapter) {
    return { ok: false, error: 'external_harness_unsupported', message: `harness ${harness.id} has no projection adapter` };
  }
  prepared = await adapter({
    ...common,
    notify: buildHarnessProgressNotifier(input.progress),
    dshPath: input.binaryPath
  });

  return {
    ...prepared,
    ok: true,
    harness: harness.id,
    label: harness.label,
    interactiveKind: harness.interactiveKind,
    requestedModel,
    model: prepared.model,
    alias: aliasResult.alias
  };
}

function resolveExternalHarnessCommand(prepared, input = {}) {
  if (prepared && prepared.command) return prepared.command;
  const file = String(input.binaryPath || (prepared && prepared.harness) || '').trim();
  return {
    file,
    args: Array.isArray(prepared && prepared.args) ? prepared.args : []
  };
}

function spawnExternalHarness(prepared, input = {}) {
  if (!prepared || prepared.ok !== true) {
    return Promise.resolve({ ok: false, error: 'external_harness_not_prepared' });
  }
  const platform = String(input.platform || process.platform);
  const command = resolveExternalHarnessCommand(prepared, input);
  if (!command.file) {
    return Promise.resolve({ ok: false, error: 'external_harness_binary_missing' });
  }
  const launch = resolveWindowsUpstreamSpawn(command.file, command.args, {
    platform,
    env: input.env,
    path: input.path || nodePath
  });
  const env = buildExternalHarnessEnv(input.env, {
    ...(prepared.env || {}),
    ...(launch.envPatch || {})
  });
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: input.cwd || process.cwd(),
        env,
        stdio: 'inherit',
        windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
        windowsHide: false
      });
    } catch (error) {
      resolve({ ok: false, error: 'external_harness_spawn_failed', message: String(error && error.message || error) });
      return;
    }
    child.on('error', (error) => {
      resolve({ ok: false, error: 'external_harness_spawn_failed', message: String(error && error.message || error) });
    });
    child.on('close', (code, signal) => {
      resolve({
        ok: true,
        code: signal ? 130 : (Number.isInteger(code) ? code : 0),
        signal: signal || null
      });
    });
  });
}

async function runExternalHarness(input = {}) {
  const prepared = await prepareExternalHarness(input);
  if (!prepared.ok) return prepared;
  return spawnExternalHarness(prepared, input);
}

module.exports = {
  NATIVE_CREDENTIAL_ENV,
  buildExternalHarnessEnv,
  buildHarnessProgressNotifier,
  prepareExternalHarness,
  runExternalHarness,
  spawnExternalHarness
};
