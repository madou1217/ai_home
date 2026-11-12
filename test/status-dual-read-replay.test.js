'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'status-dual-read-replay.js');
const REPLAY_MODULE = path.join(__dirname, '..', 'scripts', 'status-dual-read-replay.js');

// 用临时目录造一份「线上日志」：真实日志不进仓库，测试也不该依赖 ~/.ai_home 的现状。
function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-status-replay-'));
}

function writeJournal(dir, events) {
  const file = path.join(dir, 'status-events.jsonl');
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return file;
}

function event(accountRef, provider, payload) {
  return Object.assign({ v: 1, accountRef, provider }, payload);
}

// 假 oracle：把请求原样交给被测脚本自己导出的 Node 回放，再按 Go 的响应格式吐回去。
// 这不是在验证 Go 的语义（那是 core/accounts 双读测试的事），而是在验证这条链路的接线：
// 请求构造、stdin/stdout 一問一答、id 匹配、JSON 规范化、逐字段 diff。
function writeFakeOracle(dir) {
  const file = path.join(dir, 'fake-oracle.js');
  const source = [
    "'use strict';",
    'const { replaySteps } = require(process.argv[2]);',
    "const mode = process.argv[3] || 'correct';",
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const lines = input.split('\\n').filter((line) => line.trim());",
    '  for (const line of lines) {',
    '    const request = JSON.parse(line);',
    '    const results = replaySteps(request.provider, request.steps).map((item) => ({',
    '      atMs: item.atMs,',
    '      runtimeState: item.runtimeState,',
    '      status: item.status,',
    "      error: ''",
    '    }));',
    "    if (mode === 'tamperState' && results.length) {",
    '      results[0].runtimeState = Object.assign({}, results[0].runtimeState, {',
    '        cooldownUntil: ((results[0].runtimeState && results[0].runtimeState.cooldownUntil) || 0) + 1',
    '      });',
    '    }',
    "    if (mode === 'tamperStatus' && results.length) {",
    "      results[results.length - 1].status = 'tampered';",
    '    }',
    '    process.stdout.write(JSON.stringify({ id: request.id, results }) + \'\\n\');',
    '  }',
    '});'
  ].join('\n');
  fs.writeFileSync(file, source);
  return file;
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
  } catch (error) {
    assert.fail('报告不是合法 JSON:\n' + stdout);
  }
}

function syntheticEvents(base) {
  return [
    event('acct_0123456789abcdef0123', 'codex', {
      atMs: base,
      op: 'failure',
      failure: { kind: 'auth_invalid', reason: '401 unauthorized', cooldownMs: 300_000, routingBlockRecheck: null }
    }),
    event('acct_0123456789abcdef0123', 'codex', { atMs: base + 60_000, op: 'clear', evidence: 'login_success' }),
    event('acct_0123456789abcdef0123', 'codex', {
      atMs: base + 120_000,
      op: 'failure',
      failure: { kind: 'rate_limited', reason: '429', cooldownMs: 60_000, routingBlockRecheck: null }
    }),
    event('acct_0123456789abcdef0456', 'codex', {
      atMs: base + 1_000,
      op: 'failure',
      failure: { kind: 'overloaded', reason: 'overloaded', cooldownMs: 30_000, routingBlockRecheck: null }
    }),
    event('acct_0123456789abcdef0456', 'codex', { atMs: base + 30_000, op: 'runtime_state', state: null })
  ];
}

test('合成 journal：两账号逐步与 oracle 一致时零分歧', () => {
  const dir = makeWorkspace();
  const journal = writeJournal(dir, syntheticEvents(1_790_000_000_000));
  const oracle = writeFakeOracle(dir);

  const result = runCli(['--journal', journal, '--json', '--oracle', process.execPath + ' ' + oracle + ' ' + REPLAY_MODULE]);

  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result.stdout);
  assert.equal(report.accounts, 2);
  assert.equal(report.steps, 5);
  assert.deepEqual(report.divergences, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.truncations, []);
});

test('oracle 输出被改坏时能定位到账号、步骤与字段', () => {
  const dir = makeWorkspace();
  const journal = writeJournal(dir, syntheticEvents(1_790_000_000_000));
  const oracle = writeFakeOracle(dir);

  const command = process.execPath + ' ' + oracle + ' ' + REPLAY_MODULE;
  const stateResult = runCli(['--journal', journal, '--json', '--fail-on-divergence', '--oracle', command + ' tamperState']);
  assert.equal(stateResult.status, 1, stateResult.stderr);
  const stateReport = parseReport(stateResult.stdout);
  assert.ok(stateReport.divergences.length > 0, '改坏的 cooldownUntil 必须被检出');
  const stateHit = stateReport.divergences.find((item) => item.field === 'runtimeState.cooldownUntil');
  assert.ok(stateHit, JSON.stringify(stateReport.divergences));
  assert.equal(stateHit.accountRef, 'acct_0123456789abcdef0123');
  assert.equal(stateHit.step, 1);

  const statusResult = runCli(['--journal', journal, '--json', '--fail-on-divergence', '--oracle', command + ' tamperStatus']);
  assert.equal(statusResult.status, 1, statusResult.stderr);
  const statusReport = parseReport(statusResult.stdout);
  assert.ok(statusReport.divergences.some((item) => item.field === 'status'), JSON.stringify(statusReport.divergences));

  // 人类可读格式按契约固定为 "account step field: node=... go=..."
  const human = runCli(['--journal', journal, '--oracle', command + ' tamperStatus']);
  assert.equal(human.status, 0, '没带 --fail-on-divergence 时分歧不改变退出码');
  assert.match(human.stdout, /acct_0123456789abcdef0123 step \d+ status: node="[^"]*" go="tampered"/);
});

test('journal 缺失或为空：正常退出 0 并说明原因', () => {
  const dir = makeWorkspace();
  const missing = runCli(['--journal', path.join(dir, 'nope.jsonl'), '--json']);
  assert.equal(missing.status, 0);
  const missingReport = parseReport(missing.stdout);
  assert.equal(missingReport.accounts, 0);
  assert.deepEqual(missingReport.divergences, []);

  const missingHuman = runCli(['--journal', path.join(dir, 'nope.jsonl')]);
  assert.equal(missingHuman.status, 0);
  assert.match(missingHuman.stdout, /日志不存在/);

  const emptyFile = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(emptyFile, '\n');
  const empty = runCli(['--journal', emptyFile]);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /日志为空/);
});

test('单账号事件超过 200 步时截断并记录', () => {
  const dir = makeWorkspace();
  const base = 1_790_000_000_000;
  const events = [];
  for (let index = 0; index < 205; index += 1) {
    events.push(event('acct_0123456789abcdef0789', 'codex', {
      atMs: base + index * 1_000,
      op: 'clear',
      evidence: 'login_success'
    }));
  }
  const journal = writeJournal(dir, events);
  const oracle = writeFakeOracle(dir);

  const result = runCli(['--journal', journal, '--json', '--oracle', process.execPath + ' ' + oracle + ' ' + REPLAY_MODULE]);
  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result.stdout);
  assert.equal(report.accounts, 1);
  assert.equal(report.steps, 200);
  assert.equal(report.truncations.length, 1);
  assert.equal(report.truncations[0].kept, 200);
  assert.equal(report.truncations[0].dropped, 5);
  assert.deepEqual(report.divergences, []);
});

test('--limit 只重放文件里的前 N 条事件', () => {
  const dir = makeWorkspace();
  const journal = writeJournal(dir, syntheticEvents(1_790_000_000_000));
  const oracle = writeFakeOracle(dir);

  const result = runCli([
    '--journal', journal, '--json', '--limit', '3',
    '--oracle', process.execPath + ' ' + oracle + ' ' + REPLAY_MODULE
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result.stdout);
  assert.equal(report.steps, 3);
  // 前 3 条都属于第一个账号，第二个账号不该出现在这次抽样里。
  assert.equal(report.accounts, 1);
});

test('oracle 起不来或非零退出：errors 记录且退出码 2', () => {
  const dir = makeWorkspace();
  const journal = writeJournal(dir, syntheticEvents(1_790_000_000_000));

  const broken = runCli(['--journal', journal, '--json', '--oracle', path.join(dir, 'no-such-binary')]);
  assert.equal(broken.status, 2, broken.stderr);
  const brokenReport = parseReport(broken.stdout);
  assert.ok(brokenReport.errors.length > 0);
  assert.equal(brokenReport.errors[0].source, 'oracle');

  const crashing = path.join(dir, 'crashing-oracle.js');
  fs.writeFileSync(crashing, "process.stderr.write('boom'); process.exit(3);\n");
  const crashResult = runCli(['--journal', journal, '--json', '--oracle', process.execPath + ' ' + crashing]);
  assert.equal(crashResult.status, 2);
  const crashReport = parseReport(crashResult.stdout);
  assert.ok(crashReport.errors.some((item) => /退出码 3/.test(item.message)), JSON.stringify(crashReport.errors));
  assert.match(crashReport.errors.map((item) => item.message).join('\n'), /boom/);
});

test('坏行只跳过并记录，不污染其它事件', () => {
  const dir = makeWorkspace();
  const journal = path.join(dir, 'status-events.jsonl');
  const lines = [
    JSON.stringify(syntheticEvents(1_790_000_000_000)[0]),
    '{ this is not json',
    JSON.stringify(event('acct_0123456789abcdef0456', 'codex', {
      atMs: 1_790_000_001_000,
      op: 'failure',
      failure: { kind: 'overloaded', reason: 'overloaded', cooldownMs: 30_000, routingBlockRecheck: null }
    }))
  ];
  fs.writeFileSync(journal, lines.join('\n') + '\n');
  const oracle = writeFakeOracle(dir);

  const result = runCli(['--journal', journal, '--json', '--oracle', process.execPath + ' ' + oracle + ' ' + REPLAY_MODULE]);
  // 比对本身不完整（少了一条事件），必须让调用方看见，所以有 errors 就是 2。
  assert.equal(result.status, 2, result.stderr);
  const report = parseReport(result.stdout);
  assert.equal(report.accounts, 2);
  assert.equal(report.steps, 2);
  assert.ok(report.errors.some((item) => item.line === 2));
  assert.deepEqual(report.divergences, []);
});
