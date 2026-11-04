'use strict';

// `aih ls` 的三条硬约束：
//   1. 第一帧只依赖账号索引 —— 渲染必须发生在读凭据/用量之前（否则列表要等好几秒）；
//   2. `aih <provider> ls` 走轻量入口，绝不装配完整 CLI 组合根（server / webui / chat）；
//   3. 轻量入口的输出必须和完整 CLI 逐字节一致（两份装配不能漂移）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createProfileListService } = require('../lib/cli/services/profile/list');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { registerAccountIdentity } = require('../lib/account/account-registration');

const REPO_ROOT = path.join(__dirname, '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'ai-home.js');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ls-fastpath-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedAccount(aiHomeDir, provider, name) {
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    identitySeed: `fastpath:${provider}:${name}`
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  try {
    index.upsertRuntimeState(account.accountRef, provider, {}, {
      status: 'up',
      configured: true,
      displayName: name
    });
  } finally {
    index.close();
  }
  return account;
}

function runCli({ home, aiHomeDir, args, env = {} }) {
  return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      AIH_HOME_DIR: aiHomeDir,
      AIH_HOST_HOME: home,
      ...env
    }
  });
}

test('轻量入口与完整 CLI 的输出逐字节一致', (t) => {
  const home = tempHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  seedAccount(aiHomeDir, 'codebuddy', 'FastPath Demo');
  seedAccount(aiHomeDir, 'codebuddy', 'FastPath Second');
  seedAccount(aiHomeDir, 'codebuddycn', 'FastPath CN');

  const fast = runCli({ home, aiHomeDir, args: ['codebuddy', 'ls'] });
  const full = runCli({ home, aiHomeDir, args: ['codebuddy', 'ls'], env: { AIH_DISABLE_LS_FASTPATH: '1' } });
  assert.equal(fast, full);

  const fastAll = runCli({ home, aiHomeDir, args: ['ls'] });
  const fullAll = runCli({ home, aiHomeDir, args: ['ls'], env: { AIH_DISABLE_LS_FASTPATH: '1' } });
  assert.equal(fastAll, fullAll);
});

test('aih <provider> ls 不装配完整 CLI 组合根', (t) => {
  const home = tempHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  seedAccount(aiHomeDir, 'codebuddy', 'FastPath Demo');

  const marker = path.join(home, 'loaded.txt');
  const guard = path.join(home, 'guard.js');
  fs.writeFileSync(guard, `
const Module = require('module');
const { isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
const orig = Module._load;
const forbidden = /(^|[\\\\/])(lib[\\\\/]cli[\\\\/]app|lib[\\\\/]server[\\\\/]server)(\\\\.js)?$/;
Module._load = function (request, parent, isMain) {
  if (isMainThread && forbidden.test(String(request || ''))) {
    fs.appendFileSync(process.env.AIH_LS_GUARD_MARKER, String(request) + '\\n');
  }
  return orig.apply(this, arguments);
};
`, 'utf8');

  runCli({
    home,
    aiHomeDir,
    args: ['codebuddy', 'ls'],
    env: {
      NODE_OPTIONS: `--require=${guard}`,
      AIH_LS_GUARD_MARKER: marker
    }
  });
  assert.equal(fs.existsSync(marker), false, 'ls 不应加载完整组合根');
});

test('先出列表、后补数据：第一帧早于任何凭据/用量读取', (t) => {
  const aiHomeDir = tempHome(t);
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codebuddy',
    identitySeed: 'fastpath:two-phase'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertAccountState(account.accountRef, 'codebuddy', {
    status: 'up',
    configured: true,
    displayName: 'Two Phase Demo',
    remainingPct: 61
  });
  index.upsertRuntimeState(account.accountRef, 'codebuddy', {}, {
    status: 'up',
    configured: true,
    displayName: 'Two Phase Demo'
  });

  const writes = [];
  const proc = {
    platform: 'linux',
    stdout: { isTTY: true, write: (chunk) => writes.push(String(chunk)), columns: 120 },
    stderr: { write() {} },
    // 没有 resume()：动画定时器 unref，测试进程能自己退出。
    stdin: {},
    on() {}, off() {}, exit() {},
    env: {}
  };

  const enrichCalls = [];
  const enricher = {
    request(tasks) {
      enrichCalls.push(tasks.map((task) => task.accountRef));
      return new Promise((resolve) => {
        setTimeout(() => resolve(tasks.map((task) => ({
          provider: task.provider,
          accountRef: task.accountRef,
          status: { configured: true, accountName: 'Enriched Name' },
          apiKeyMode: false,
          baseUrl: '',
          derived: { status: 'up', configured: true, remainingPct: 61 },
          usageLabel: '\x1b[36m[Credits: 61.0%]\x1b[0m',
          planBadge: ''
        }))), 30);
      });
    },
    close() {}
  };

  const service = createProfileListService({
    fs,
    path,
    processObj: proc,
    aiHomeDir,
    cliConfigs: { codebuddy: {} },
    listPageSize: 50,
    getAccountStateIndex: () => index,
    checkStatus: () => { throw new Error('第一帧不该读凭据'); },
    formatAccountPlanBadge: () => '',
    formatUsageLabel: () => { throw new Error('第一帧不该读用量'); },
    refreshIndexedStateForAccount: () => { throw new Error('第一帧不该刷新索引'); },
    accountEnricher: enricher
  });

  const listed = service.listProfiles('codebuddy');
  assert.equal(listed.interactive, true);

  // runAnimatedList 在构造时就画了第一帧：此时还没有发起任何补算。
  const firstFrame = writes.join('');
  assert.match(firstFrame, /Two Phase Demo/);
  assert.match(firstFrame, /\[Remaining: 61\.0%\]/);
  assert.equal(enrichCalls.length, 0, '补算必须排在第一帧之后');

  return new Promise((resolve) => {
    setTimeout(() => {
      // 增量重绘会把一帧拆成多段写，断言要看整段输出。
      const all = writes.join('');
      assert.ok(enrichCalls.length >= 1, '第一帧之后应当发起补算');
      assert.match(all, /Enriched Name/);
      assert.match(all, /Credits: 61\.0%/);
      assert.equal(listed.interactive, true);
      resolve();
    }, 200);
  });
});
