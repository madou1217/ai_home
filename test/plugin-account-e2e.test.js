'use strict';

// P4 真实插件 E2E：打包示例账号插件 → 安装 → 启用插件宿主 → 粘贴 token 登录 →
// 宿主物化投影并注册账号 → 刷新 → 取消。全部在临时 AIH_HOME_DIR 中运行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildArtifact } = require('../lib/plugins/control/artifact');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');

const EXAMPLE_DIR = path.join(__dirname, '..', 'examples', 'plugins', 'account-paste-token');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-account-e2e-'));
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

test('account plugin completes install -> paste login -> materialize -> refresh -> cancel', { timeout: 30000 }, async (t) => {
  const dir = tempDir();
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const system = createPluginSystem({
    aiHomeDir,
    socketPath: path.join(dir, 'plugin.sock'),
    providerDescriptorSync: false,
    backoffMs: [100]
  });
  t.after(async () => {
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artifact = buildArtifact(EXAMPLE_DIR, path.join(dir, 'account-paste-token.aih-plugin'));
  system.control.install(artifact.file);
  await system.control.enable({
    pluginId: 'aih.demo.account.paste-token',
    instanceId: 'paste-token-demo'
  });

  const listing = await system.account.listSources('opencode');
  const source = listing.sources.find((item) => item.id === 'paste-token');
  assert.ok(source);
  assert.equal(source.loginAvailable, true);

  const started = await system.account.startLogin({ provider: 'opencode', sourceId: 'paste-token' });
  assert.equal(started.status, 'waiting_user');
  assert.equal(started.canSubmit, true);
  assert.equal(started.submitLabel, '提交 API Key');

  const token = `e2e-${Date.now()}-secret`;
  const finished = await system.account.submitLogin(started.jobId, { value: token });
  assert.equal(finished.status, 'success');
  assert.match(finished.accountRef, /^acct_/);

  const authFile = listFiles(path.join(aiHomeDir, 'run', 'login', 'opencode'))
    .find((file) => file.endsWith(path.join('.local', 'share', 'opencode', 'auth.json')));
  assert.ok(authFile, '宿主应把 credential 物化成 opencode auth.json');
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).opencode.key, token);

  const jobsFile = path.join(aiHomeDir, 'plugins', 'account-login-jobs.json');
  assert.equal(fs.existsSync(jobsFile), true);
  assert.doesNotMatch(fs.readFileSync(jobsFile, 'utf8'), new RegExp(token));

  const runtimeDir = path.resolve(authFile, '..', '..', '..', '..');
  const refreshed = await system.account.refresh({
    provider: 'opencode',
    accountRef: finished.accountRef,
    runtimeDir,
    credential: { token }
  });
  assert.equal(refreshed.handled, true);
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).opencode.key, token);

  const cancellable = await system.account.startLogin({ provider: 'opencode', sourceId: 'paste-token' });
  const cancelled = await system.account.cancelLogin(cancellable.jobId);
  assert.equal(cancelled.status, 'cancelled');
});
