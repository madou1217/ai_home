'use strict';

// `aih ls` 的一行放不下所有用量分组：TTY 下按时间轮换，一次只显示一条；
// 管道/重定向保持"全量一行"，脚本读起来稳定。
// 每条候选都是完整 `[Remaining: ...]` 片段（分组 / 百分比+积分由 presenter 拆）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ROTATE_INTERVAL_MS,
  rotationTick,
  createProfileListService
} = require('../lib/cli/services/profile/list');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ls-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('轮换相位：同一时间片内稳定，跨片递增 1；不同账号相位错开', () => {
  const now = 1_700_000_000_000;
  const first = rotationTick('codebuddy:acct_a', now, 5000);
  assert.equal(rotationTick('codebuddy:acct_a', now + 1, 5000), first);
  assert.equal(rotationTick('codebuddy:acct_a', now + 5000, 5000), first + 1);
  assert.equal(ROTATE_INTERVAL_MS, 5000);

  // 不同 key 的相位不同 → 翻页时刻错开（不是整屏同一刻一起跳）。
  const keys = Array.from({ length: 12 }, (_v, index) => `codebuddy:acct_${index}`);
  const flips = keys.map((key) => {
    const base = rotationTick(key, now, 5000);
    for (let delta = 1; delta <= 5000; delta += 1) {
      if (rotationTick(key, now + delta, 5000) !== base) return delta;
    }
    return 0;
  });
  assert.ok(new Set(flips).size >= 3, `不同账号应错开翻页时刻，实际 ${new Set(flips).size} 种`);
});

function buildService(t, { isTTY, writes }) {
  const aiHomeDir = tempHome(t);
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codebuddy',
    identitySeed: `rotation:${isTTY ? 'tty' : 'pipe'}`
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertAccountState(account.accountRef, 'codebuddy', {
    status: 'up',
    configured: true,
    displayName: 'Rotation Demo',
    remainingPct: 50
  });
  index.upsertRuntimeState(account.accountRef, 'codebuddy', {}, {
    status: 'up',
    configured: true,
    displayName: 'Rotation Demo'
  });

  const processObj = {
    platform: 'linux',
    stdout: {
      isTTY,
      columns: 120,
      rows: 40,
      write: (chunk) => { if (writes) writes.push(String(chunk)); }
    },
    stderr: { write() {} },
    stdin: {},
    on() {}, off() {}, exit() {},
    env: {}
  };

  const service = createProfileListService({
    fs,
    path,
    processObj,
    aiHomeDir,
    cliConfigs: { codebuddy: {} },
    listPageSize: 50,
    rotateIntervalMs: 120,
    getAccountStateIndex: () => index,
    checkStatus: () => ({ configured: true, accountName: 'Rotation Demo' }),
    formatUsageLabel: () => '\x1b[36m[Remaining: A / B]\x1b[0m',
    formatUsageLabelVariants: () => [
      '\x1b[36m[Remaining: A]\x1b[0m',
      '\x1b[36m[Remaining: B]\x1b[0m'
    ],
    formatAccountPlanBadge: () => '',
    refreshIndexedStateForAccount: () => ({ status: 'up', configured: true, remainingPct: 50 })
  });
  return service;
}

test('TTY：一次只显示一条用量，按时间轮换', async (t) => {
  const writes = [];
  const service = buildService(t, { isTTY: true, writes });
  const listed = service.listProfiles('codebuddy');
  assert.equal(listed.interactive, true);

  // 第一帧来自索引（还没有分组数据），但整个 TTY 过程都不能出现合并形态。
  assert.ok(!writes.join('').includes('A / B'), 'TTY 下不能把多组合并成一条');

  await sleep(700);
  const all = writes.join('');
  assert.match(all, /\[Remaining: A\]/, '应出现第一条候选');
  assert.match(all, /\[Remaining: B\]/, '应轮换到第二条候选');
  assert.ok(!all.includes('A / B'), 'TTY 全程都不该出现合并形态');
});

test('管道输出：保持全量一行，不轮换', async (t) => {
  const service = buildService(t, { isTTY: false, writes: null });
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const listed = service.listProfiles('codebuddy');
    assert.equal(listed.interactive, false);
    await listed.done;
  } finally {
    console.log = originalLog;
  }
  const row = lines.find((line) => line.includes('Account ID:'));
  assert.ok(row, `account row missing: ${lines.join(' | ')}`);
  assert.match(row, /\[Remaining: A \/ B\]/, '管道输出应保留全部分组');
});
