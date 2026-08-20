'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  compareVersions,
  createAppUpdateChecker,
  queryHomebrewCaskLatestVersion,
  queryWingetLatestVersion
} = require('../lib/cli/services/toolkit/app-update-checker');

function fakeCommandProcess(stdout, stderr = '', status = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', status);
  });
  return child;
}

test('app-update-checker 按 semver 主版本与 prerelease 顺序比较', () => {
  assert.equal(compareVersions('v1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.10'), 1);
  assert.equal(compareVersions('unversioned', '1.0.0'), null);
});

test('app-update-checker 对同一 package 做 in-flight 去重并缓存十分钟', async () => {
  let nowValue = 1000;
  let queryCount = 0;
  const checker = createAppUpdateChecker({
    now: () => nowValue,
    queryLatestVersion: async (packageName) => {
      queryCount += 1;
      assert.equal(packageName, '@example/tool');
      return { ok: true, latestVersion: '2.0.0' };
    }
  });

  const [first, second] = await Promise.all([
    checker.getLatestVersion('@example/tool'),
    checker.getLatestVersion('@example/tool')
  ]);
  assert.deepEqual(first, { ok: true, latestVersion: '2.0.0' });
  assert.deepEqual(second, first);
  assert.equal(queryCount, 1);

  nowValue += 9 * 60 * 1000;
  assert.deepEqual(await checker.getLatestVersion('@example/tool'), first);
  assert.equal(queryCount, 1);

  nowValue += 60 * 1000;
  assert.deepEqual(await checker.getLatestVersion('@example/tool'), first);
  assert.equal(queryCount, 2);
});

test('app-update-checker 远端失败时不误报更新，并缓存失败结果', async () => {
  let queryCount = 0;
  const checker = createAppUpdateChecker({
    queryLatestVersion: async () => {
      queryCount += 1;
      return { ok: false, error: 'registry_unreachable' };
    }
  });
  const app = {
    id: 'example',
    provider: 'example',
    version: '1.0.0',
    pkg: '@example/tool'
  };

  const first = await checker.check(app);
  const second = await checker.check(app);
  assert.equal(first.ok, false);
  assert.equal(first.updateAvailable, false);
  assert.equal(first.latestVersion, null);
  assert.equal(first.status, 'unavailable');
  assert.equal(first.error, 'latest_version_unavailable');
  assert.equal(second.ok, false);
  assert.equal(second.updateAvailable, false);
  assert.equal(queryCount, 1);
});

test('app-update-checker 只有当前版本落后时才标记 available', async () => {
  const checker = createAppUpdateChecker({
    queryLatestVersion: async () => ({ ok: true, latestVersion: '1.2.0' })
  });

  const available = await checker.check({
    id: 'example-old',
    provider: 'example',
    version: '1.1.9',
    pkg: 'example-tool'
  });
  const current = await checker.check({
    id: 'example-current',
    provider: 'example',
    version: '1.2.0',
    pkg: 'example-tool'
  });
  const unknown = await checker.check({
    id: 'example-unknown',
    provider: 'example',
    version: '探测中',
    pkg: 'example-tool'
  });

  assert.equal(available.status, 'available');
  assert.equal(available.updateAvailable, true);
  assert.equal(current.status, 'current');
  assert.equal(current.updateAvailable, false);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.updateAvailable, false);
});

test('app-update-checker 按 Desktop 官方安装来源查询 Homebrew cask 与 winget', async () => {
  const calls = [];
  const checker = createAppUpdateChecker({
    queryHomebrewCaskLatestVersion: async (cask) => {
      calls.push(['homebrew_cask', cask]);
      return { ok: true, latestVersion: '2.0.0' };
    },
    queryWingetLatestVersion: async (id) => {
      calls.push(['winget', id]);
      return { ok: true, latestVersion: '3.0.0' };
    }
  });

  const caskResult = await checker.check({
    id: 'codex-desktop',
    provider: 'codex',
    version: '1.5.0',
    pkg: '@openai/codex',
    versionSource: { type: 'homebrew_cask', cask: 'chatgpt' }
  });
  const wingetResult = await checker.check({
    id: 'codex-desktop',
    provider: 'codex',
    version: '3.0.0',
    versionSource: { type: 'winget', id: 'OpenAI.ChatGPT' }
  });

  assert.equal(caskResult.status, 'available');
  assert.equal(caskResult.updateAvailable, true);
  assert.equal(wingetResult.status, 'current');
  assert.deepEqual(calls, [
    ['homebrew_cask', 'chatgpt'],
    ['winget', 'OpenAI.ChatGPT']
  ]);
});

test('app-update-checker 的 Homebrew 与 winget 查询使用远端元数据命令并解析版本', async () => {
  const calls = [];
  const cask = await queryHomebrewCaskLatestVersion('chatgpt', {
    spawn(command, args) {
      calls.push([command, args]);
      return fakeCommandProcess(JSON.stringify({ casks: [{ token: 'chatgpt', version: '26.1.2' }] }));
    }
  });
  const winget = await queryWingetLatestVersion('OpenAI.ChatGPT', {
    processObj: { platform: 'win32' },
    spawn(command, args) {
      calls.push([command, args]);
      return fakeCommandProcess('Name: ChatGPT\nVersion: 26.2.0\n');
    }
  });

  assert.deepEqual(cask, { ok: true, cask: 'chatgpt', latestVersion: '26.1.2' });
  assert.deepEqual(winget, { ok: true, id: 'OpenAI.ChatGPT', latestVersion: '26.2.0' });
  assert.deepEqual(calls, [
    ['brew', ['info', '--cask', '--json=v2', 'chatgpt']],
    ['winget.exe', [
      'show', '--id', 'OpenAI.ChatGPT', '--exact', '--source', 'winget',
      '--accept-source-agreements', '--disable-interactivity'
    ]]
  ]);
});
