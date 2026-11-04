'use strict';

// 回归守卫（2026-11-04）：`aih zcode <id> -p` 的换路会落到 runner 垫片（独立 Node
// 进程），它读账号库/会话库时会把
//   (node:70537) ExperimentalWarning: SQLite is an experimental feature
// 打到 stderr。用户看到的是「aih 自己吐 Node 警告」，而且会污染 `-p` 的 stdout。
//
// 规则：所有会首次打开 node:sqlite 的进程入口都要装过滤；CLI 子进程统一
// NODE_NO_WARNINGS=1（vendor CLI 的警告对用户无价值）；zcode driver 再显式带
// --disable-warning，覆盖直接调用 driver 的场景。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('垫片进程 require 时就装好 sqlite 警告过滤', () => {
  const trampoline = path.join(ROOT, 'lib', 'cli', 'services', 'pty', 'headless-runner-trampoline.js');
  const result = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(trampoline)});
    process.stdout.write(String(process.__aihSqliteWarningFiltered === true));
  `], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'true');
  assert.ok(!/SQLite is an experimental feature/i.test(result.stderr), result.stderr);
});

test('NODE_NO_WARNINGS=1 的子进程不会打出 SQLite ExperimentalWarning（机制自检）', () => {
  const result = spawnSync(process.execPath, ['-e', "require('node:sqlite')"], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('所有会开 sqlite 的进程入口都装了警告过滤', () => {
  const entries = [
    'bin/ai-home.js',
    'lib/cli/services/pty/headless-runner-trampoline.js',
    'lib/cli/services/profile/account-enrich-worker.js',
    'lib/usage/model-usage-query-worker.js',
    'lib/usage/model-usage-scan-worker.js',
    'lib/cli/services/ai-cli/persistent-session-rows-worker.js'
  ];
  for (const entry of entries) {
    assert.match(read(entry), /installSqliteWarningFilter\(process\)/, `${entry} 缺少过滤器`);
  }
});

test('CLI 子进程 env 静音 Node 警告，zcode driver 也显式声明', () => {
  assert.match(
    read('lib/cli/services/pty/pty-runtime-spawn.js'),
    /envOverrides\.NODE_NO_WARNINGS = '1'/,
    'pty-runtime-spawn 未给子进程注入 NODE_NO_WARNINGS'
  );
  assert.match(
    read('lib/cli/services/ai-cli/zcode-app-server-run.js'),
    /--disable-warning=ExperimentalWarning/,
    'zcode app-server child 未声明 --disable-warning'
  );
});
