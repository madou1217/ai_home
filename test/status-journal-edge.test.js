'use strict';

// 边界测试：状态事件日志（lib/server/status-event-journal.js）与双读回放脚本
// （scripts/status-dual-read-replay.js）。
//
// 正常路径已由 status-event-journal.test.js / status-dual-read-replay.test.js 覆盖；
// 这里只钉住六个容易静默退化的边界：
//   1. 默认 5MiB 容量轮转与「只保留一份 .1」；
//   2. 未启用 / 禁用后 append 的零副作用；
//   3. journal 单行损坏时逐行跳过并保留行号；
//   4. 空 journal 的 replay 必须正常结束而不是报错；
//   5. 单账号超过 200 步时先排序再截断，且保留最早的一段；
//   6. 注入假 oracle 后必须能同时检出多字段分歧与 results.length 分歧。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const journal = require('../lib/server/status-event-journal');
const replay = require('../scripts/status-dual-read-replay');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'status-dual-read-replay.js');
const REPLAY_MODULE = SCRIPT;

const ACCOUNT_A = 'acct_0123456789abcdef0123';
const ACCOUNT_B = 'acct_0123456789abcdef0456';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    journal.disable();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  });
  return dir;
}

function journalFile(home) {
  return path.join(home, 'observability', journal.FILE_NAME);
}

function archiveFile(home) {
  return path.join(home, 'observability', journal.ARCHIVE_FILE_NAME);
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function baseEvent(overrides = {}) {
  return {
    accountRef: ACCOUNT_A,
    provider: 'codex',
    atMs: 1_790_000_000_000,
    ...overrides
  };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT].concat(args), {
    encoding: 'utf8',
    timeout: 60_000
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function parseReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_error) {
    assert.fail('报告不是合法 JSON:\n' + stdout);
  }
}

// 假 oracle：用被测脚本自己的 Node 回放算出「正确结果」，再按模式注入偏差。
// 这样测的是双读链路的接线（请求构造 / id 匹配 / 逐字段 diff），而不是 Go 语义。
function writeFakeOracle(dir) {
  const file = path.join(dir, 'fake-oracle.js');
  const source = [
    "'use strict';",
    'const { replaySteps } = require(process.argv[2]);',
    "const mode = process.argv[3] || 'correct';",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  for (const line of input.split('\\n')) {",
    '    if (!line.trim()) continue;',
    '    const request = JSON.parse(line);',
    '    let results = replaySteps(request.provider, request.steps).map((item) => ({',
    '      atMs: item.atMs,',
    '      runtimeState: item.runtimeState,',
    '      status: item.status,',
    "      error: ''",
    '    }));',
    "    if (mode === 'tamper' && results.length) {",
    "      results[0].status = 'tampered';",
    '      results[0].runtimeState = Object.assign({}, results[0].runtimeState || {}, { injected: true });',
    "    } else if (mode === 'drop-last') {",
    '      results = results.slice(0, -1);',
    '    }',
    "    process.stdout.write(JSON.stringify({ id: request.id, results }) + '\\n');",
    '  }',
    '});'
  ].join('\n');
  fs.writeFileSync(file, source);
  return file;
}

function oracleCommand(oracle, mode) {
  return '"' + process.execPath + '" "' + oracle + '" "' + REPLAY_MODULE + '" ' + mode;
}

test('默认 5MiB 上限：跨阈值轮转，且只保留一份 .1 旧档', async (t) => {
  journal.disable();
  assert.equal(journal.DEFAULT_MAX_BYTES, 5 * 1024 * 1024, '默认上限必须是 5MiB');

  const home = tempDir(t, 'aih-status-journal-5mib-');
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);

  // 用 4KB 的 runtime_state 把单行撑大，避免写几十万条小事件拖慢测试。
  const note = 'x'.repeat(4096);
  const perBatch = 700;
  const appendBatch = (offset) => {
    for (let index = 0; index < perBatch; index += 1) {
      assert.equal(journal.append(baseEvent({
        atMs: 1_790_000_000_000 + offset + index,
        op: 'runtime_state',
        state: { note }
      })), true);
    }
  };

  const main = journalFile(home);
  const archive = archiveFile(home);

  appendBatch(0);
  assert.equal(await journal.flush(), true);
  const sizeA = fs.statSync(main).size;
  assert.equal(fs.existsSync(archive), false, '首批未超限时不该轮转');
  assert.equal(sizeA < journal.DEFAULT_MAX_BYTES, true);

  appendBatch(100_000);
  assert.equal(await journal.flush(), true);
  const sizeB = fs.statSync(main).size;
  assert.equal(
    sizeA + sizeB > journal.DEFAULT_MAX_BYTES,
    true,
    '两批合计必须越过 5MiB，否则这条用例没有真正触发轮转'
  );
  assert.equal(fs.existsSync(archive), true, '越过上限后必须把旧文件 rename 成 .1');
  assert.equal(fs.statSync(archive).size, sizeA, '.1 必须完整保留轮转前的主文件');
  assert.equal(sizeB <= journal.DEFAULT_MAX_BYTES, true, '轮转后的主文件不得超过 5MiB');

  appendBatch(200_000);
  assert.equal(await journal.flush(), true);
  const sizeC = fs.statSync(main).size;
  assert.equal(fs.statSync(archive).size, sizeB, '第二次轮转必须覆盖旧的 .1，而不是再存一份');
  assert.equal(sizeC <= journal.DEFAULT_MAX_BYTES, true);
  assert.deepEqual(
    fs.readdirSync(path.join(home, 'observability')).sort(),
    [journal.ARCHIVE_FILE_NAME, journal.FILE_NAME].sort(),
    'observability 目录里只应有主文件和一份旧档'
  );

  const archived = readEvents(archive);
  const current = readEvents(main);
  assert.equal(archived.length, perBatch);
  assert.equal(current.length, perBatch);
  assert.equal(archived[0].atMs, 1_790_000_100_000, '.1 里应是第二批，证明只保留一代旧档');
  assert.equal(current[0].atMs, 1_790_000_200_000);
});

test('未启用 / 禁用后 append 零副作用：不建目录、不写文件、不抛错', async (t) => {
  journal.disable();
  const home = tempDir(t, 'aih-status-journal-off-');
  const observability = path.join(home, 'observability');
  const event = baseEvent({ op: 'clear', evidence: 'login_success' });

  assert.equal(journal.isEnabled(), false);
  assert.equal(journal.append(event), false);
  assert.equal(journal.append(null), false);
  assert.equal(await journal.flush(), false);
  assert.equal(journal.disable(), false);
  assert.equal(fs.existsSync(observability), false, '未启用时连 observability 目录都不该创建');
  assert.deepEqual(fs.readdirSync(home), []);

  // 非法 enable 参数（缺 fs / 缺目录）同样不能留下痕迹。
  assert.equal(journal.enable({ aiHomeDir: home }), false);
  assert.equal(journal.enable({ fs, aiHomeDir: '' }), false);
  assert.deepEqual(fs.readdirSync(home), []);

  // disable 之后再 append：不得把事件写回刚关闭的旧文件。
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);
  assert.equal(journal.append(event), true);
  assert.equal(await journal.flush(), true);
  const file = journalFile(home);
  const sizeBefore = fs.statSync(file).size;
  assert.equal(journal.disable(), true);
  assert.equal(journal.isEnabled(), false);
  assert.equal(journal.append(event), false);
  assert.equal(await journal.flush(), false);
  assert.equal(fs.statSync(file).size, sizeBefore, '禁用后的 append 不得改变文件大小');
  assert.equal(readEvents(file).length, 1);
});

test('readJournal 逐行跳过非法记录：坏行报行号，合法事件不受影响', (t) => {
  const dir = tempDir(t, 'aih-status-journal-badlines-');
  const file = path.join(dir, 'journal.jsonl');
  const line = (payload) => JSON.stringify(Object.assign({
    v: 1,
    accountRef: ACCOUNT_A,
    provider: 'codex'
  }, payload));
  const validFailure = line({
    atMs: 1_790_000_000_000,
    op: 'failure',
    failure: { kind: 'auth_invalid', reason: '401', cooldownMs: 1_000, routingBlockRecheck: null }
  });
  const validClear = line({ atMs: 1_790_000_001_000, op: 'clear', evidence: 'login_success' });
  const lines = [
    validFailure,                                                        // 1  合法
    '',                                                                  // 2  空行
    '{ "v": 1, ',                                                        // 3  半行
    '[]',                                                                // 4  不是对象
    line({ v: 2, atMs: 1_790_000_002_000, op: 'clear', evidence: 'login_success' }), // 5 版本不认识
    line({ atMs: -1, op: 'clear', evidence: 'login_success' }),          // 6 atMs 非法
    line({ atMs: 1_790_000_003_000, op: 'clear', evidence: 'login_success', accountRef: '' }), // 7 缺 accountRef
    line({ atMs: 1_790_000_003_000, op: 'clear', evidence: 'login_success', provider: '  ' }), // 8 缺 provider
    line({ atMs: 1_790_000_004_000, op: 'bogus' }),                      // 9 未知 op
    line({ atMs: 1_790_000_005_000, op: 'failure' }),                    // 10 failure 缺负载
    line({ atMs: 1_790_000_006_000, op: 'clear', evidence: 42 }),        // 11 evidence 不是字符串
    validClear,                                                          // 12 合法
    line({ atMs: 1_790_000_007_000, op: 'runtime_state' }),              // 13 合法（state 缺省）
    'null',                                                              // 14 不是对象
    line({ atMs: 1_790_000_008_000, op: 'runtime_state', state: null })  // 15 合法（显式清空）
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const result = replay.readJournal(file, 0);
  assert.equal(result.missing, false);
  assert.equal(result.empty, false);
  assert.deepEqual(result.events.map((event) => event.op), ['failure', 'clear', 'runtime_state', 'runtime_state']);
  assert.equal(result.events[2].state, undefined, '缺省 state 与显式 null 必须能区分');
  assert.equal(result.events[3].state, null);

  assert.deepEqual(
    result.errors.map((error) => error.line),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 14],
    '空行不报错，坏行必须逐行记录行号'
  );
  const messages = result.errors.map((error) => error.message).join('\n');
  assert.match(messages, /不是合法 JSON/);
  assert.match(messages, /事件不是对象/);
  assert.match(messages, /未登记的事件版本/);
  assert.match(messages, /atMs 不是非负数字/);
  assert.match(messages, /缺少 accountRef/);
  assert.match(messages, /缺少 provider/);
  assert.match(messages, /未知 op/);
  assert.match(messages, /failure 事件缺少 failure 负载/);
  assert.match(messages, /clear 事件缺少 evidence/);
});

test('空 journal：replay 正常结束，零账号零分歧零错误', (t) => {
  const dir = tempDir(t, 'aih-status-replay-empty-');
  const file = path.join(dir, 'status-events.jsonl');
  fs.writeFileSync(file, '\n   \n');

  const json = runCli(['--journal', file, '--json', '--fail-on-divergence']);
  assert.equal(json.status, 0, json.stderr);
  const report = parseReport(json.stdout);
  assert.equal(report.accounts, 0);
  assert.equal(report.steps, 0);
  assert.deepEqual(report.divergences, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.truncations, []);

  const human = runCli(['--journal', file]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /日志为空，无事件可比对/);
  assert.doesNotMatch(human.stdout, /divergences=/);
});

test('单账号超过 200 步：按 atMs 稳定排序后保留最早 200 步', () => {
  const base = 1_790_000_000_000;
  const total = 250;
  const events = [];
  // 97 与 250 互质：文件顺序是一个确定的乱序，用来验证「排序发生在截断之前」。
  for (let index = 0; index < total; index += 1) {
    events.push({
      atMs: base + ((index * 97) % total) * 1_000,
      accountRef: 'acct_big',
      provider: 'codex',
      op: 'clear',
      evidence: 'login_success'
    });
  }
  for (let index = 0; index < 3; index += 1) {
    events.push({
      atMs: base + 900_000 + index,
      accountRef: 'acct_small',
      provider: 'codex',
      op: 'runtime_state',
      state: null
    });
  }

  assert.equal(replay.MAX_STEPS_PER_ACCOUNT, 200);
  const errors = [];
  const accounts = replay.groupByAccount(events, errors);
  assert.deepEqual(errors, []);

  const { prepared, truncations } = replay.splitAccounts(accounts);
  assert.equal(truncations.length, 1, '只有超过上限的账号才记录截断');
  assert.deepEqual(truncations[0], {
    accountRef: 'acct_big',
    kept: 200,
    dropped: 50,
    fromAtMs: base,
    toAtMs: base + 199_000
  });

  const big = prepared.find((entry) => entry.account.accountRef === 'acct_big');
  assert.equal(big.steps.length, 200);
  assert.deepEqual(
    big.steps.map((step) => step.atMs),
    Array.from({ length: 200 }, (_, index) => base + index * 1_000),
    '保留的必须是最早的 200 步，且已按时间升序'
  );
  const request = replay.buildRequest(big.account, big.steps);
  assert.equal(request.steps.length, 200);
  assert.equal(request.steps[0].atMs, base);
  assert.equal(request.steps[199].atMs, base + 199_000);

  const small = prepared.find((entry) => entry.account.accountRef === 'acct_small');
  assert.equal(small.steps.length, 3, '未超限的账号不得被截断');
});

test('注入假 oracle：多字段分歧与 results.length 分歧都能被检出', (t) => {
  const dir = tempDir(t, 'aih-status-replay-oracle-');
  const file = path.join(dir, 'status-events.jsonl');
  const events = [
    { v: 1, atMs: 1_790_000_000_000, accountRef: ACCOUNT_A, provider: 'codex', op: 'failure', failure: { kind: 'auth_invalid', reason: '401', cooldownMs: 300_000, routingBlockRecheck: null } },
    { v: 1, atMs: 1_790_000_060_000, accountRef: ACCOUNT_A, provider: 'codex', op: 'clear', evidence: 'login_success' },
    { v: 1, atMs: 1_790_000_001_000, accountRef: ACCOUNT_B, provider: 'codex', op: 'runtime_state', state: null }
  ];
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const oracle = writeFakeOracle(dir);

  // 1) 同时改 status 和 runtimeState：一次运行要把两个字段都报出来。
  const tampered = runCli([
    '--journal', file, '--json', '--fail-on-divergence',
    '--oracle', oracleCommand(oracle, 'tamper')
  ]);
  assert.equal(tampered.status, 1, tampered.stderr);
  const tamperedReport = parseReport(tampered.stdout);
  assert.deepEqual(tamperedReport.errors, []);

  const forA = tamperedReport.divergences.filter((item) => item.accountRef === ACCOUNT_A);
  const forB = tamperedReport.divergences.filter((item) => item.accountRef === ACCOUNT_B);
  const statusA = forA.find((item) => item.field === 'status' && item.step === 1);
  assert.ok(statusA, JSON.stringify(forA));
  assert.equal(statusA.node === 'tampered', false);
  assert.equal(statusA.go, 'tampered');
  const injectedA = forA.find((item) => item.field === 'runtimeState.injected' && item.step === 1);
  assert.ok(injectedA, JSON.stringify(forA));
  assert.equal(injectedA.node, null);
  assert.equal(injectedA.go, true);
  assert.ok(forB.some((item) => item.field === 'status' && item.step === 1), JSON.stringify(forB));
  assert.ok(forB.some((item) => item.field === 'runtimeState'), JSON.stringify(forB));

  // 2) 不带 --fail-on-divergence：分歧照样报告，但不改变退出码。
  const lenient = runCli(['--journal', file, '--json', '--oracle', oracleCommand(oracle, 'tamper')]);
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.ok(parseReport(lenient.stdout).divergences.length > 0);

  // 3) oracle 少返回一条结果：必须报 results.length，而不是静默按较短的一侧比对。
  const dropped = runCli([
    '--journal', file, '--json', '--fail-on-divergence',
    '--oracle', oracleCommand(oracle, 'drop-last')
  ]);
  assert.equal(dropped.status, 1, dropped.stderr);
  const droppedReport = parseReport(dropped.stdout);
  const lengthHit = droppedReport.divergences.find((item) => item.field === 'results.length');
  assert.ok(lengthHit, JSON.stringify(droppedReport.divergences));
  assert.equal(lengthHit.accountRef, ACCOUNT_A);
  assert.equal(lengthHit.step, 0);
  assert.equal(lengthHit.node, 2);
  assert.equal(lengthHit.go, 1);
  assert.deepEqual(droppedReport.errors, []);
});
