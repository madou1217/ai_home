'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCodexStartupPolicyArgs,
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
} = require('../lib/cli/services/ai-cli/codex-provider-args');
const { buildCodexGatewayConnection } = require('../lib/server/codex-gateway-connection');
const { APP_SERVER_PINS_GATEWAY_PROVIDER } = require('../lib/server/codex-app-server-endpoint');

test('codex startup policy args suppress warnings and disable update checks', () => {
  assert.deepEqual(buildCodexStartupPolicyArgs(), [
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'check_for_update_on_startup=false'
  ]);
});

test('codex provider args inject endpoint through config and keep the key in env', () => {
  const args = buildCodexProviderArgs({
    OPENAI_API_KEY: 'secret-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
  });

  assert.deepEqual(args, [
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'model_provider=aih_server',
    '-c', 'model_providers.aih_server.base_url=http://127.0.0.1:9527/v1',
    '-c', 'model_providers.aih_server.wire_api=responses'
  ]);
  assert.equal(args.join(' ').includes('secret-key'), false);
});

test('codex provider args stay quotable-free for the windows cmd transport', () => {
  // Windows 上这些参数会经 buildPtyLaunch 的 cmd.exe 包装传递；node-pty 把
  // " 转义成 \" 后 cmd.exe 无法解析（2026-08-22 codex 启动报
  // `was unexpected at this time` 事故）。回归守卫：值里不允许出现引号或空格，
  // provider 显示名只能由 codex-config-sync 写入 config.toml。
  const args = buildCodexProviderArgs({
    OPENAI_API_KEY: 'secret-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
  });
  args.forEach((arg, index) => {
    if (index % 2 === 0) return; // 只检查 -c 的值
    assert.equal(/["\s]/.test(arg), false, `arg contains quote/space: ${arg}`);
  });
  assert.equal(args.some((arg) => /model_providers\..*\.name=/.test(arg)), false);
});

test('codex provider args leave native OAuth config untouched', () => {
  assert.deepEqual(buildCodexProviderArgs({}), []);
});

test('codex key-only launch preserves the endpoint supplied by managed config', () => {
  const args = buildCodexProviderArgs({ OPENAI_API_KEY: 'test-key' });
  assert.ok(args.includes('model_provider=aih_server'));
  assert.equal(args.some((arg) => arg.includes('.base_url=')), false);
  assert.equal(args.some((arg) => arg.includes('api.openai.com')), false);
});

test('codex provider args recognize valid split and long-form model-provider overrides', () => {
  assert.equal(hasCodexModelProviderArg(['-c', 'model_provider=custom']), true);
  assert.equal(hasCodexModelProviderArg(['--config', 'model_provider=custom']), true);
  assert.equal(hasCodexModelProviderArg(['--config=model_provider=custom']), true);
  assert.equal(hasCodexModelProviderArg(['-c model_provider=custom']), false);
  assert.equal(hasCodexModelProviderArg(['--model', 'gpt-5.4']), false);
});

test('codex provider args are scoped after native subcommands', () => {
  const providerArgs = ['-c', 'model_provider=aih_server'];

  assert.deepEqual(
    injectCodexProviderArgs(['exec', '--json'], providerArgs),
    ['exec', '-c', 'model_provider=aih_server', '--json']
  );
  assert.deepEqual(
    injectCodexProviderArgs(['resume', 'thread-id'], providerArgs),
    ['resume', '-c', 'model_provider=aih_server', 'thread-id']
  );
  assert.deepEqual(
    injectCodexProviderArgs(['app-server', '--listen', 'ws://127.0.0.1:1234'], providerArgs),
    ['app-server', '-c', 'model_provider=aih_server', '--listen', 'ws://127.0.0.1:1234']
  );
  assert.deepEqual(
    injectCodexProviderArgs(['--version'], providerArgs),
    ['-c', 'model_provider=aih_server', '--version']
  );
  assert.deepEqual(
    injectCodexProviderArgs(['--', 'resume'], providerArgs),
    ['-c', 'model_provider=aih_server', '--', 'resume']
  );
  assert.deepEqual(
    injectCodexProviderArgs(['--model', 'resume', 'prompt'], providerArgs),
    ['-c', 'model_provider=aih_server', '--model', 'resume', 'prompt']
  );
});

// codex-app-server-endpoint.js 用 APP_SERVER_PINS_GATEWAY_PROVIDER 向身份校验方声明
// 「我起的 app-server 一定被钉在本机网关上，所以 codex 不会自报账号」。那个声明成立的前提就是
// 下面这条链：网关连接 env 的两个值都有兜底 → 永远非空 → 即使 force 为 false 也必然吐出
// model_provider 覆盖。哪天 endpoint 改成有条件钉而常量忘了跟着改，闸门会静默放松，
// 所以把前提本身钉成测试。
test('gateway connection env forces the provider override even when force is false', () => {
  for (const config of [{}, { port: 9527, apiKey: '' }, { host: '127.0.0.1', apiKey: 'aih_client_x' }]) {
    const { env } = buildCodexGatewayConnection(config, 'acct_11111111111111111111');
    assert.ok(env.OPENAI_BASE_URL, 'base url must never be empty');
    assert.ok(env.OPENAI_API_KEY, 'api key must never be empty');
    assert.ok(
      buildCodexProviderArgs(env, { force: false }).includes('model_provider=aih_server'),
      'per-account app-server is pinned to the aih provider regardless of force'
    );
  }
  assert.equal(APP_SERVER_PINS_GATEWAY_PROVIDER, true);
});
