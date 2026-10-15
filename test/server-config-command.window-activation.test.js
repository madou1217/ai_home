'use strict';

// 「窗口激活」的全局开关必须有一条正规入口：`aih server config set --window-activation`。
// 只有逐账号开关、没有全局入口时，账号页把开关打开也不会发任何探测（探测是真实上游请求）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseServerConfigArgs,
  runServerConfigCommand,
  toPublicServerConfig
} = require('../lib/server/server-config-command');
const {
  readServerConfig,
  writeServerConfig
} = require('../lib/server/server-config-store');

test('server config accepts the window activation global opt-in flags', () => {
  assert.deepEqual(parseServerConfigArgs(['set', '--window-activation']).patch, { windowActivation: true });
  assert.deepEqual(parseServerConfigArgs(['set', '--no-window-activation']).patch, { windowActivation: false });
  // 与 `--go-core` 等既有 flag 组合时互不覆盖。
  assert.deepEqual(
    parseServerConfigArgs(['set', '--window-activation', '--go-core']).patch,
    { windowActivation: true, goCoreEnabled: true }
  );
  assert.equal(parseServerConfigArgs(['show']).hasPatch, false);
});

test('public server config exposes the window activation switch', () => {
  assert.equal(toPublicServerConfig({ windowActivation: true }).windowActivation, true);
  assert.equal(toPublicServerConfig({}).windowActivation, false);
});

test('config set writes the switch and restart picks it up from saved config', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-config-window-activation-cmd-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = {
    readServerConfig: () => readServerConfig({ fs, aiHomeDir }),
    writeServerConfig: (patch) => writeServerConfig(patch, { fs, aiHomeDir })
  };

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let code;
  try {
    code = await runServerConfigCommand(['set', '--window-activation'], deps);
  } finally {
    console.log = originalLog;
  }

  assert.equal(code, 0);
  assert.equal(readServerConfig({ fs, aiHomeDir }).windowActivation, true);
  // 打印与落盘必须一致：用户就是靠 show 输出确认「到底开没开」。
  assert.equal(logs.some((line) => line.includes('window_activation: enabled')), true);
  assert.equal(logs.some((line) => line.includes('aih server restart')), true);
});
