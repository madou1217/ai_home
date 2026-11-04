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

  const guardedEnv = {
    NODE_OPTIONS: `--require=${guard}`,
    AIH_LS_GUARD_MARKER: marker
  };
  runCli({ home, aiHomeDir, args: ['codebuddy', 'ls'], env: guardedEnv });
  assert.equal(fs.existsSync(marker), false, 'ls 不应加载完整组合根');

  // provider 目录查询同样是热路径（`aih provider ls` 是最常用的发现入口）。
  runCli({ home, aiHomeDir, args: ['provider', 'ls'], env: guardedEnv });
  assert.equal(fs.existsSync(marker), false, 'provider ls 不应加载完整组合根');
});

test('先出列表、后补数据：第一帧早于任何凭据/用量读取', async (t) => {
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

  // 补算是异步的（setImmediate → 请求 → 下一帧重绘），机器繁忙时 200ms 不够；
  // 用轮询等结果，避免"跑得快就绿、跑得慢就红"的假失败。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (writes.join('').includes('Enriched Name')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 增量重绘会把一帧拆成多段写，断言要看整段输出。
  const all = writes.join('');
  assert.ok(enrichCalls.length >= 1, '第一帧之后应当发起补算');
  assert.match(all, /Enriched Name/);
  assert.match(all, /Credits: 61\.0%/);
  assert.equal(listed.interactive, true);
});

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function runCliResult({ home, aiHomeDir, args, env = {} }) {
  try {
    return { status: 0, stdout: runCli({ home, aiHomeDir, args, env }), stderr: '' };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || '')
    };
  }
}

test('provider 位通配：*buddy* / *buddy 按作用域列账号，且与 --scope 等价', (t) => {
  const home = tempHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  seedAccount(aiHomeDir, 'codebuddy', 'CB One');
  seedAccount(aiHomeDir, 'codebuddycn', 'CB CN');
  seedAccount(aiHomeDir, 'workbuddy', 'WB One');
  seedAccount(aiHomeDir, 'workbuddycn', 'WB CN');
  seedAccount(aiHomeDir, 'codex', 'Codex One');

  // 不带通配符的子串写法：zsh 不会提前展开，用户不用记着加引号。
  const bare = runCli({ home, aiHomeDir, args: ['buddy', 'ls'] });
  const globbed = runCli({ home, aiHomeDir, args: ['*buddy*', 'ls'] });
  assert.equal(bare, globbed, '子串与通配必须给同一份输出');
  assert.match(globbed, /codebuddy/);
  assert.match(globbed, /codebuddycn/);
  assert.match(globbed, /workbuddy/);
  assert.match(globbed, /workbuddycn/);
  assert.doesNotMatch(globbed, /codex/, '通配符必须真的过滤，不能退化成全量');

  // 同一份名单的两种写法必须逐字节一致。
  const scoped = runCli({ home, aiHomeDir, args: ['ls', '--scope', 'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'] });
  assert.equal(globbed, scoped);

  const suffix = runCli({ home, aiHomeDir, args: ['*buddy', 'ls'] });
  assert.match(suffix, /codebuddy/);
  assert.match(suffix, /workbuddy/);
  assert.doesNotMatch(suffix, /codebuddycn/);

  // 轻量入口与完整 CLI 必须给同一份输出（两份装配不能漂移）。
  const full = runCli({ home, aiHomeDir, args: ['*buddy*', 'ls'], env: { AIH_DISABLE_LS_FASTPATH: '1' } });
  assert.equal(globbed, full);
});

test('provider 位通配匹配不到时报错，不退化成全量列表', (t) => {
  const home = tempHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  seedAccount(aiHomeDir, 'codebuddy', 'CB One');

  const result = runCliResult({ home, aiHomeDir, args: ['buddy*', 'ls'] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No provider matches "buddy\*"/);
  // 建议必须是不带 * 的写法：照抄带 * 的建议在 zsh 里只会再报一次错。
  assert.match(result.stderr, /Did you mean "buddy" \(no quotes or wildcards needed\)/);
  assert.equal(result.stdout.trim(), '', '报错时不能顺手打出全量账号');

  const badScope = runCliResult({ home, aiHomeDir, args: ['ls', '--scope', 'nope'] });
  assert.equal(badScope.status, 1);
  assert.match(badScope.stderr, /Known providers/);
});

test('aih provider ls 列出 provider 目录与账号数', (t) => {
  const home = tempHome(t);
  const aiHomeDir = path.join(home, '.ai_home');
  seedAccount(aiHomeDir, 'codebuddy', 'CB One');
  seedAccount(aiHomeDir, 'codebuddy', 'CB Two');
  seedAccount(aiHomeDir, 'workbuddy', 'WB One');

  const all = stripAnsi(runCli({ home, aiHomeDir, args: ['provider', 'ls'] }));
  assert.match(all, /codebuddy\s+2 accounts/);
  assert.match(all, /workbuddy\s+1 account/);
  assert.match(all, /workbuddycn\s+0 accounts/);
  assert.match(all, /no native CLI/, '没有原生 CLI 的 provider 要标出来');

  const filtered = stripAnsi(runCli({ home, aiHomeDir, args: ['provider', 'ls', '*buddy*'] }));
  assert.match(filtered, /codebuddy/);
  assert.match(filtered, /workbuddycn/);
  assert.doesNotMatch(filtered, /codex/);

  const json = JSON.parse(runCli({ home, aiHomeDir, args: ['provider', 'ls', '--json'] }));
  assert.equal(json.ok, true);
  assert.ok(json.providers.some((row) => row.provider === 'codebuddy' && row.accounts === 2));

  // 轻量入口与完整 CLI 必须给同一份输出。
  for (const args of [['provider', 'ls'], ['provider', 'ls', '*buddy*'], ['provider', 'ls', '--json']]) {
    const fast = runCli({ home, aiHomeDir, args });
    const full = runCli({ home, aiHomeDir, args, env: { AIH_DISABLE_LS_FASTPATH: '1' } });
    assert.equal(fast, full, `${args.join(' ')} 的两条路径输出必须一致`);
  }
});
