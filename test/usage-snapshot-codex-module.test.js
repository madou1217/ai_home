'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// 回归（eb5b5293）：一次脚本化编辑把 require 插进了 app-server 探测子进程的模板字符串，
// 父函数里 getCodexClientVersion 未定义、子进程里相对路径又解析不到——Codex 额度刷新
// 全部失败，而后台刷新任务把错误吞掉，WebUI 只看到一直转圈。
test('codex usage module imports the client version at module scope, not inside the probe script', () => {
  const file = path.join(__dirname, '..', 'lib', 'cli', 'services', 'usage', 'usage-snapshot-codex.js');
  assert.doesNotThrow(() => require(file));
  const source = fs.readFileSync(file, 'utf8');
  const probeStart = source.indexOf('const probeScript = `');
  assert.ok(probeStart > 0, 'probe script template exists');
  const probeEnd = source.indexOf('`;', probeStart);
  const probeScript = source.slice(probeStart, probeEnd);
  assert.equal(/require\(['"]\.\.?\//.test(probeScript), false, 'child probe script must not use relative requires');
  const header = source.slice(0, probeStart);
  assert.match(header, /^const \{ getCodexClientVersion \} = require\('\.\.\/\.\.\/\.\.\/server\/codex-client-version'\);$/m);
});
