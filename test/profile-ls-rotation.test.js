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
  ROTATE_STEP_MS,
  rotationTurn,
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

test('轮换调度：全局节拍轮流，每个节拍最多一个账号换内容', () => {
  assert.equal(ROTATE_STEP_MS, 1500);
  const count = 5;
  const turnAt = (step) => Array.from({ length: count }, (_v, slot) => rotationTurn({
    slot,
    rotatingCount: count,
    stepMs: 1000,
    startedAt: 0,
    nowMs: step * 1000
  }));

  // 首屏全部展示下标 0；之后每一拍正好一个账号 +1。
  assert.deepEqual(turnAt(0), [0, 0, 0, 0, 0]);
  let previous = turnAt(0);
  for (let step = 1; step <= count * 3; step += 1) {
    const current = turnAt(step);
    const changed = current.filter((value, index) => value !== previous[index]);
    assert.equal(changed.length, 1, `第 ${step} 拍应正好一个账号换内容，实际 ${changed.length}`);
    previous = current;
  }

  // 每个账号每 count 拍才轮到自己一次。
  assert.equal(turnAt(1)[0], 1);
  assert.equal(turnAt(count)[0], 1);
  assert.equal(turnAt(count + 1)[0], 2);
});

function buildService(t, { isTTY, writes, checkStatus, runtimeState }) {
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
  index.upsertRuntimeState(account.accountRef, 'codebuddy', runtimeState || {}, {
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
    rotateStepMs: 120,
    getAccountStateIndex: () => index,
    checkStatus: checkStatus || (() => ({ configured: true, accountName: 'Rotation Demo' })),
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

async function capturePipedRow(service) {
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
  return lines.find((line) => line.includes('Account ID:'));
}

test('认证失效不再重复：[认证失效] 徽章之外不再贴 [Auth: expired]', async (t) => {
  const service = buildService(t, {
    isTTY: false,
    checkStatus: () => ({
      configured: true,
      accountName: 'Demo',
      runtimeStatus: 'auth_invalid',
      runtimeReason: 'zcode_access_token_expired'
    })
  });
  const row = await capturePipedRow(service);
  assert.match(row, /认证失效/);
  assert.ok(!row.includes('Auth: expired'), `不应重复认证失效：${row}`);
  assert.ok(!/\[Runtime:/.test(row), `不应再有运行态兜底标签：${row}`);
});

test('账号级限流只出现一次：[限流: 账号 至 …]，不再叠 [Runtime: rate limited]', async (t) => {
  const until = Date.now() + 3600 * 1000;
  const service = buildService(t, {
    isTTY: false,
    runtimeState: { rateLimitUntil: until },
    checkStatus: () => ({ configured: true, accountName: 'Demo' })
  });
  const row = await capturePipedRow(service);
  assert.match(row, /\[限流: 账号 至 /);
  assert.ok(!/Runtime: rate limited/.test(row), `不应重复限流原因：${row}`);
});

test('TTY：身份按 WebUI 优先级（邮箱 → 手机 → 昵称）轮换', async (t) => {
  const writes = [];
  const service = buildService(t, {
    isTTY: true,
    writes,
    checkStatus: () => ({
      configured: true,
      accountName: '昵称甲',
      nickname: '昵称甲',
      phone: '13800000000',
      email: 'a@b.com'
    })
  });
  service.listProfiles('codebuddy');
  await sleep(800);

  const plain = writes.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const seq = [];
  for (const match of plain.matchAll(/\(([^()]*)\)/g)) {
    const value = match[1];
    if (value.includes('/|') || value.includes('\ / |')) continue;
    if (!seq.length || seq[seq.length - 1] !== value) seq.push(value);
  }
  assert.ok(seq.includes('a@b.com'), `缺少邮箱：${seq.join(',')}`);
  assert.ok(seq.includes('13800000000'), `缺少手机号：${seq.join(',')}`);
  assert.ok(seq.includes('昵称甲'), `缺少昵称：${seq.join(',')}`);
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
