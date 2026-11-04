'use strict';

// 补算 worker 绝对不能往 stderr 写东西：TUI 用绝对行号重绘，worker 的
// "SQLite is an experimental feature" 警告会把整屏顶下去，导致账号串到别的
// provider 分组下面（2026-11-04 真机事故）。主线程的警告过滤管不到 worker，
// 必须在 worker 自己线程里装。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  isSqliteExperimentalWarning,
  installSqliteWarningFilter
} = require('../lib/runtime/sqlite-warning-filter');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-worker-silent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('过滤器只吞 sqlite 的 ExperimentalWarning，其它告警照常放行', () => {
  assert.equal(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', ['ExperimentalWarning']), true);
  assert.equal(isSqliteExperimentalWarning('SQLite is an experimental feature', ['DeprecationWarning']), false);
  assert.equal(isSqliteExperimentalWarning('something else', ['ExperimentalWarning']), false);

  const seen = [];
  const fake = {
    emitWarning: (warning, type) => seen.push([warning, type])
  };
  installSqliteWarningFilter(fake);
  fake.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  fake.emitWarning('other warning', 'DeprecationWarning');
  assert.deepEqual(seen, [['other warning', 'DeprecationWarning']]);
});

test('worker 打开 sqlite 时不向 stderr 打警告', (t) => {
  const home = tempDir(t);
  const workerPath = path.join(__dirname, '..', 'lib', 'cli', 'services', 'profile', 'account-enrich-worker.js');
  const script = `
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(${JSON.stringify(workerPath)}, {
      workerData: { aiHomeDir: process.env.TEST_HOME, hostHomeDir: process.env.TEST_HOME }
    });
    worker.on('message', () => { worker.terminate(); });
    worker.on('error', () => { process.exit(3); });
    worker.postMessage({ id: 1, tasks: [{ provider: 'codebuddy', accountRef: 'acct_' + 'a'.repeat(20) }] });
    setTimeout(() => process.exit(0), 4000);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TEST_HOME: home },
    timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/SQLite is an experimental feature/i.test(result.stderr), `worker stderr 有噪音：${result.stderr}`);
});
