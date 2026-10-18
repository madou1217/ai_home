'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildClaudeAccountRelayEnv,
  buildClaudeLaunchSettingsArgs,
  resolveClaudeLaunchSettingsDir,
  shouldRelayClaudeAccount
} = require('../lib/cli/services/ai-cli/claude-account-relay');
const { claudeRelayProfile } = require('../lib/cli/services/ai-cli/relay/claude-relay-profile');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

test('Claude native OAuth accounts relay through the gateway by accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: ACCOUNT_REF,
    accountEnv: {}
  }), true);

  assert.deepEqual(buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF), {
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
    ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
  });
});

test('Claude relay is disabled for gateway and login modes', () => {
  const base = { provider: 'claude', accountRef: ACCOUNT_REF, accountEnv: {} };
  assert.equal(shouldRelayClaudeAccount({ ...base, gateway: true }), false);
  assert.equal(shouldRelayClaudeAccount({ ...base, isLogin: true }), false);
});

test('Claude API key and auth token accounts relay through the gateway by accountRef', () => {
  const base = { provider: 'claude', accountRef: ACCOUNT_REF };
  assert.equal(shouldRelayClaudeAccount({ ...base, accountEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } }), true);
  assert.equal(shouldRelayClaudeAccount({ ...base, accountEnv: { ANTHROPIC_AUTH_TOKEN: 'direct-token' } }), true);
});

test('Claude relay rejects mutable CLI ids and accepts only accountRef', () => {
  assert.equal(shouldRelayClaudeAccount({
    provider: 'claude',
    accountRef: '9',
    accountEnv: {}
  }), false);
  assert.throws(
    () => buildClaudeAccountRelayEnv({}, '9'),
    /invalid_claude_relay_account_ref/
  );
});

test('aih Claude launches hand the gateway address and pin to --settings so host settings cannot hijack them', () => {
  const relayEnv = buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF);
  const args = buildClaudeLaunchSettingsArgs(relayEnv, ['-p', 'hi']);
  assert.equal(args[0], '--settings');
  assert.deepEqual(JSON.parse(args[1]), {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
      ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`
    }
  });
  assert.doesNotMatch(args[1], /gateway-key/, 'argv 对本机可见，不能带密钥');

  // 不钉选的 AIH Server 启动显式清空钉选头，宿主默认的钉选不会被继承。
  const gatewayArgs = buildClaudeLaunchSettingsArgs({ ANTHROPIC_API_KEY: 'gateway-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' });
  assert.equal(JSON.parse(gatewayArgs[1]).env.ANTHROPIC_CUSTOM_HEADERS, '');

  assert.deepEqual(buildClaudeLaunchSettingsArgs({}), [], '没有网关地址时不整形');
  assert.deepEqual(buildClaudeLaunchSettingsArgs(relayEnv, ['--settings', '/tmp/x.json']), [], '用户自带 --settings 时不覆盖');
  assert.deepEqual(buildClaudeLaunchSettingsArgs(relayEnv, ['--settings=/tmp/x.json']), []);
});

test('the Claude relay profile prefixes --settings for every non-login launch', () => {
  const accountEnv = buildClaudeAccountRelayEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' }, ACCOUNT_REF);
  const launch = claudeRelayProfile.buildRelayLaunch({ args: ['--resume', 'abc'], accountEnv, isLogin: false });
  assert.equal(launch.args[0], '--settings');
  assert.deepEqual(launch.args.slice(2), ['--resume', 'abc']);
  assert.equal(claudeRelayProfile.buildRelayLaunch({ args: [], accountEnv, isLogin: true }), null);
  assert.equal(claudeRelayProfile.buildRelayLaunch({ args: [], accountEnv: {}, isLogin: false }), null);
});

function createTempAiHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.ai_home');
}

test('aih Claude launches hand the gateway credential to a 0600 settings file, never to argv', (t) => {
  const aiHomeDir = createTempAiHome(t);
  const settingsDir = resolveClaudeLaunchSettingsDir(aiHomeDir);
  assert.equal(settingsDir, path.join(aiHomeDir, 'run', 'claude-launch-settings'));
  const relayEnv = buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF);

  const args = buildClaudeLaunchSettingsArgs(relayEnv, ['-p', 'hi'], { fs, settingsDir });

  assert.equal(args.length, 2);
  assert.equal(args[0], '--settings');
  assert.equal(path.dirname(args[1]), settingsDir);
  assert.doesNotMatch(args.join(' '), /gateway-key/, 'argv 对本机可见，不能带密钥');
  assert.equal(fs.statSync(args[1]).mode & 0o777, 0o600);
  // 网关凭据写进 x-api-key 槽，另一个槽（Bearer）显式置空，压掉宿主 settings.json 里手写的值。
  assert.deepEqual(JSON.parse(fs.readFileSync(args[1], 'utf8')), {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
      ANTHROPIC_CUSTOM_HEADERS: `x-account-ref: ${ACCOUNT_REF}`,
      ANTHROPIC_API_KEY: 'gateway-key',
      ANTHROPIC_AUTH_TOKEN: ''
    }
  });

  // 同一组合复用同一个文件（不随启动次数堆积），也不留临时文件。
  assert.deepEqual(buildClaudeLaunchSettingsArgs(relayEnv, [], { fs, settingsDir }), args);
  assert.deepEqual(fs.readdirSync(settingsDir), [path.basename(args[1])]);

  // auth-token 形态：Bearer 槽带凭据，x-api-key 槽置空。
  const tokenArgs = buildClaudeLaunchSettingsArgs({
    ANTHROPIC_AUTH_TOKEN: 'gateway-token',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, [], { fs, settingsDir });
  assert.notEqual(tokenArgs[1], args[1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenArgs[1], 'utf8')).env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527',
    ANTHROPIC_CUSTOM_HEADERS: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: 'gateway-token'
  });
});

test('stale launch settings files (rotated keys) are pruned on the next write; fresh ones stay', (t) => {
  const aiHomeDir = createTempAiHome(t);
  const settingsDir = resolveClaudeLaunchSettingsDir(aiHomeDir);
  const { CLAUDE_LAUNCH_SETTINGS_RETENTION_MS } = require('../lib/cli/config/constants');
  const oldArgs = buildClaudeLaunchSettingsArgs({
    ANTHROPIC_API_KEY: 'rotated-old-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, [], { fs, settingsDir });
  const recentArgs = buildClaudeLaunchSettingsArgs({
    ANTHROPIC_API_KEY: 'recent-other-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, [], { fs, settingsDir });
  const unrelated = path.join(settingsDir, 'not-a-launch-file.json');
  fs.writeFileSync(unrelated, '{}');
  const past = (Date.now() - CLAUDE_LAUNCH_SETTINGS_RETENTION_MS - 60_000) / 1000;
  fs.utimesSync(oldArgs[1], past, past);
  fs.utimesSync(unrelated, past, past);

  const currentArgs = buildClaudeLaunchSettingsArgs({
    ANTHROPIC_API_KEY: 'current-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, [], { fs, settingsDir });

  assert.equal(fs.existsSync(oldArgs[1]), false, '过期的旧密钥文件被删除');
  assert.equal(fs.existsSync(recentArgs[1]), true, '保留期内的文件不动（可能有会话在用）');
  assert.equal(fs.existsSync(currentArgs[1]), true);
  assert.equal(fs.existsSync(unrelated), true, '只清理自己命名的文件');
});

test('without launch storage the Claude settings arg stays inline and key-free', (t) => {
  const relayEnv = { ANTHROPIC_API_KEY: 'gateway-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527' };
  const inline = buildClaudeLaunchSettingsArgs(relayEnv, []);
  assert.doesNotMatch(inline[1], /gateway-key/);
  assert.deepEqual(Object.keys(JSON.parse(inline[1]).env), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']);

  // 存储写不进去（目录被一个普通文件占住）时同样退回内联、不带密钥，启动不失败。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, '');
  const fallback = buildClaudeLaunchSettingsArgs(relayEnv, [], { fs, settingsDir: path.join(blocked, 'sub') });
  assert.doesNotMatch(fallback.join(' '), /gateway-key/);
  assert.equal(JSON.parse(fallback[1]).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9527');
});

test('the Claude relay profile writes the credential file under the launch aiHomeDir', (t) => {
  const aiHomeDir = createTempAiHome(t);
  const accountEnv = buildClaudeAccountRelayEnv({
    ANTHROPIC_API_KEY: 'gateway-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
  }, ACCOUNT_REF);
  const launch = claudeRelayProfile.buildRelayLaunch({
    args: ['--resume', 'abc'],
    accountEnv,
    isLogin: false,
    launchStorage: { fs, aiHomeDir }
  });
  assert.equal(launch.args[0], '--settings');
  assert.equal(path.dirname(launch.args[1]), resolveClaudeLaunchSettingsDir(aiHomeDir));
  assert.deepEqual(launch.args.slice(2), ['--resume', 'abc']);
  assert.doesNotMatch(launch.args.join(' '), /gateway-key/);
  assert.equal(JSON.parse(fs.readFileSync(launch.args[1], 'utf8')).env.ANTHROPIC_API_KEY, 'gateway-key');
});
