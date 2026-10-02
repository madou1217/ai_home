'use strict';

// Windows psmux 下 aih 包装器(.cmd)不能在 pane 里直接跑;旧解析沿 UPSTREAM 跟到原版 codex.js,
// 把 aih 包装层整个跳过。现在按包装器的分派规则直接用 node 启动包装层。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveWindowsCodexHookLaunch } = require('../lib/runtime/windows-codex-hook-launch');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-win-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'codex-app-server-stdio-proxy.js');
  const node = path.join(dir, 'node.exe');
  fs.writeFileSync(helper, '');
  fs.writeFileSync(node, '');
  const hook = path.join(dir, 'codex.cmd');
  fs.writeFileSync(hook, [
    '@echo off', 'REM aih-codex-cli-hook', 'setlocal',
    `set "UPSTREAM=${path.join(dir, 'codex.aih-original.cmd')}"`,
    `set "NODE_BIN=${node}"`,
    `set "HELPER=${helper}"`,
    `set "STATE_FILE=${path.join(dir, 'cli-hook-state.json')}"`,
    '"%NODE_BIN%" "%HELPER%" --run-cli-default --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*', ''
  ].join('\r\n'));
  const alias = path.join(dir, 'codex-alias.cmd');
  fs.writeFileSync(alias, ['@echo off', 'REM aih-codex-cli-hook-alias', `call "${hook}" %*`, ''].join('\r\n'));
  return { dir, helper, node, hook, alias };
}

test('an aih-hooked codex launches the aih wrapper layer directly with node', (t) => {
  const { dir, helper, node, hook, alias } = setup(t);
  for (const entry of [hook, alias]) {
    const launch = resolveWindowsCodexHookLaunch(entry, ['-c', 'model_provider=aih_server', '--model', 'gpt-6.1-sol'], { platform: 'win32' });
    assert.equal(launch.command, node);
    assert.deepEqual(launch.args, [
      helper, '--run-cli-default', '--upstream', path.join(dir, 'codex.aih-original.cmd'),
      '--state-file', path.join(dir, 'cli-hook-state.json'), '--',
      '-c', 'model_provider=aih_server', '--model', 'gpt-6.1-sol'
    ]);
  }
  assert.equal(resolveWindowsCodexHookLaunch(hook, ['-c', 'x=1', 'resume', 'abc'], { platform: 'win32' }).args[1], '--run-cli-resume');
});

test('app-server, non-hook shims and other platforms keep the previous launch', (t) => {
  const { dir, hook } = setup(t);
  assert.equal(resolveWindowsCodexHookLaunch(hook, ['app-server'], { platform: 'win32' }), null);
  assert.equal(resolveWindowsCodexHookLaunch(hook, [], { platform: 'darwin' }), null);
  const npmShim = path.join(dir, 'other.cmd');
  fs.writeFileSync(npmShim, '@ECHO off\r\nnode "%~dp0\\node_modules\\x\\bin\\x.js" %*\r\n');
  assert.equal(resolveWindowsCodexHookLaunch(npmShim, [], { platform: 'win32' }), null);
});
