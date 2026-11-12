'use strict';

// 真实 oracle 集成测试：\`scripts/status-dual-read-replay.js\` 默认的
// \`go run ./cmd/status-oracle\` 跑一份临时 journal，验证 Node 回放与 Go 复算逐字段一致。
//
// 与 status-dual-read-replay.test.js 的分工：
//   * 那份用假 oracle 验证 CLI 接线（请求构造、id 匹配、逐字段 diff），不依赖 Go；
//   * 这份只验证「真实 Go 实现对同一串事件给出同一份结果」，是 §7-d 双读的闭环。
//
// 测试需要 Go 工具链；没有时跳过而不是把 Node-only 环境判红。oracle 的冷启动由
// \`go run\` 自己缓存，spawnSync 仍按 120s 上限兜底。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'status-dual-read-replay.js');
const REPO_ROOT = path.join(__dirname, '..');
const ORACLE_TIMEOUT_MS = 120_000;

const ACCOUNT_A = 'acct_0123456789abcdef0123';
const ACCOUNT_B = 'acct_0123456789abcdef0456';
const BASE = 1_790_000_000_000;

const goProbe = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 30_000 });
const GO_AVAILABLE = goProbe.status === 0;
const SKIP_REASON = GO_AVAILABLE ? false : '未安装 Go 工具链，无法运行真实 oracle';

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  });
  return dir;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: ORACLE_TIMEOUT_MS
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function parseReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (_error) {
    assert.fail('报告不是合法 JSON（status=' + result.status + ', signal=' + result.signal + '）:\n' + result.stdout + '\n' + result.stderr);
  }
}

// 2 账号 6 步：failure / clear / runtime_state 三种 op 都覆盖。
// runtime_state 用一份完整的 Node 文档，确保比的是真实快照而不是「null 清空」。
function writeJournal(dir) {
  const file = path.join(dir, 'status-events.jsonl');
  const events = [
    {
      v: 1,
      atMs: BASE,
      accountRef: ACCOUNT_A,
      provider: 'codex',
      op: 'failure',
      failure: { kind: 'auth_invalid', reason: '401 unauthorized', cooldownMs: 300_000, routingBlockRecheck: null }
    },
    {
      v: 1,
      atMs: BASE + 120_000,
      accountRef: ACCOUNT_A,
      provider: 'codex',
      op: 'clear',
      evidence: 'login_success'
    },
    {
      v: 1,
      atMs: BASE + 180_000,
      accountRef: ACCOUNT_A,
      provider: 'codex',
      op: 'failure',
      failure: { kind: 'rate_limited', reason: '429 too many requests', cooldownMs: 60_000, routingBlockRecheck: null }
    },
    {
      v: 1,
      atMs: BASE + 1_000,
      accountRef: ACCOUNT_B,
      provider: 'codex',
      op: 'failure',
      failure: { kind: 'overloaded', reason: 'overloaded', cooldownMs: 30_000, routingBlockRecheck: null }
    },
    {
      v: 1,
      atMs: BASE + 60_000,
      accountRef: ACCOUNT_B,
      provider: 'codex',
      op: 'runtime_state',
      state: {
        modelCooldowns: {},
        modelFailureStreaks: {},
        cooldownUntil: BASE + 260_000,
        consecutiveFailures: 2,
        successCount: 1,
        failCount: 2,
        lastError: 'rate limited',
        lastFailureKind: 'rate_limited',
        lastFailureReason: '429',
        lastFailureAt: BASE + 40_000,
        lastSuccessAt: BASE + 20_000,
        rateLimitUntil: BASE + 260_000,
        authInvalidUntil: 0,
        overloadUntil: 0,
        networkUntil: 0,
        serviceUnavailableUntil: 0,
        upstreamErrorUntil: 0,
        routingBlock: null
      }
    },
    {
      v: 1,
      atMs: BASE + 90_000,
      accountRef: ACCOUNT_B,
      provider: 'codex',
      op: 'clear',
      evidence: 'upstream_success'
    }
  ];
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return file;
}

// 包装脚本：原样转发真实 oracle，只篡改第一行响应里的第一个结果。
// 这样分歧一定来自「oracle 输出被改坏」，而不是请求或 journal 本身。
// 输出很小（本用例只有 2 行），等子进程结束后一次性改写，避免流式处理在 close 之后
// 丢最后一行。
function writeTamperOracle(dir) {
  const file = path.join(dir, 'tamper-oracle.js');
  const source = [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    // runOracle 以仓库根为 cwd 启动本脚本，因此这里沿用 process.cwd()。
    "const child = spawn('go', ['run', './cmd/status-oracle'], {",
    "  cwd: process.cwd(),",
    "  stdio: ['pipe', 'pipe', 'inherit']",
    '});',
    "let buffered = '';",
    "child.stdout.on('data', (chunk) => { buffered += chunk.toString('utf8'); });",
    "child.on('close', (code) => {",
    "  const lines = buffered.split('\\n').filter((line) => line.trim());",
    '  let tampered = false;',
    '  for (let index = 0; index < lines.length; index += 1) {',
    '    if (tampered) break;',
    '    tampered = true;',
    '    try {',
    '      const response = JSON.parse(lines[index]);',
    '      const first = Array.isArray(response.results) ? response.results[0] : null;',
    '      if (first) {',
    "        first.status = 'tampered';",
    '        if (first.runtimeState) {',
    '          first.runtimeState.authInvalidUntil = (first.runtimeState.authInvalidUntil || 0) + 1;',
    '        }',
    '      }',
    '      lines[index] = JSON.stringify(response);',
    '    } catch (_error) {',
    '      // 解析失败就原样透传，让被测脚本自己报 oracle 输出错误。',
    '    }',
    '  }',
    "  if (lines.length) process.stdout.write(lines.join('\\n') + '\\n');",
    '  process.exitCode = code == null ? 1 : code;',
    '});',
    'process.stdin.pipe(child.stdin);'
  ].join('\n');
  fs.writeFileSync(file, source);
  return file;
}

function oracleCommand(wrapper) {
  return '"' + process.execPath + '" "' + wrapper + '"';
}

test('真实 Go oracle：2 账号 6 步逐字段一致', { skip: SKIP_REASON }, (t) => {
  const dir = tempDir(t, 'aih-status-oracle-real-');
  const journal = writeJournal(dir);

  // 不传 --oracle：走脚本默认的 \`go run ./cmd/status-oracle\`。
  const result = runCli(['--journal', journal, '--json', '--fail-on-divergence']);
  const report = parseReport(result);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.accounts, 2);
  assert.equal(report.steps, 6);
  assert.deepEqual(report.divergences, [], JSON.stringify(report.divergences, null, 2));
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors, null, 2));
  assert.deepEqual(report.truncations, []);
});

test('真实 Go oracle 输出被篡改：定位到账号、步骤与字段', { skip: SKIP_REASON }, (t) => {
  const dir = tempDir(t, 'aih-status-oracle-tamper-');
  const journal = writeJournal(dir);
  const wrapper = writeTamperOracle(dir);

  const result = runCli([
    '--journal', journal, '--json', '--fail-on-divergence',
    '--oracle', oracleCommand(wrapper)
  ]);
  const report = parseReport(result);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.accounts, 2);
  assert.equal(report.steps, 6);
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors, null, 2));
  assert.equal(report.divergences.length, 2, JSON.stringify(report.divergences, null, 2));

  // 只篡改了第一行（账号 A 的第一步），账号 B 必须保持零分歧。
  assert.deepEqual(
    Array.from(new Set(report.divergences.map((item) => item.accountRef))),
    [ACCOUNT_A]
  );

  const statusHit = report.divergences.find((item) => item.field === 'status');
  assert.ok(statusHit, JSON.stringify(report.divergences));
  assert.equal(statusHit.accountRef, ACCOUNT_A);
  assert.equal(statusHit.step, 1);
  assert.equal(statusHit.go, 'tampered');
  assert.notEqual(statusHit.node, 'tampered');

  const untilHit = report.divergences.find((item) => item.field === 'runtimeState.authInvalidUntil');
  assert.ok(untilHit, JSON.stringify(report.divergences));
  assert.equal(untilHit.accountRef, ACCOUNT_A);
  assert.equal(untilHit.step, 1);
  assert.equal(untilHit.go, untilHit.node + 1, '注入的是 +1ms，必须原样体现在 diff 里');
});
