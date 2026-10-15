'use strict';

// 运行态门禁的接线守卫：账号运行态只能从 account-runtime-gate 这一个出口改。
//
// 这类「谁改运行态」的接线靠行为测试很难覆盖（各 transport 的失败路径分散在几千行里），
// 所以用源码扫描把它锁住：新增/改动请求路径时若绕过门禁，这里会直接失败。
// 历史教训：探测路径曾经自己写一套内存清理 + 直接写 DB，于是探测失败不记账、
// 探测成功又把限流冷却清掉（见 account-runtime-gate 文件头）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('every inference path prefers the runtime gate over its own applier', () => {
  const files = [
    'lib/server/upstream-endpoints.js',
    'lib/server/codex-adapter.js',
    'lib/server/codex-responses-websocket.js',
    'lib/server/image-generation-executor.js'
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /accountRuntimeGate/, `${file} 必须优先使用运行态门禁`);
  }
  // 每个文件都必须保留「未装配门禁时退回原直调」的兜底（单测/降级装配）。
  assert.match(read('lib/server/upstream-endpoints.js'), /runtimeGate[\s\S]{0,400}?markProxyAccountSuccess\(account, \{ model \}\)/);
  assert.match(read('lib/server/codex-adapter.js'), /deps\.accountRuntimeGate[\s\S]{0,400}?markProxyAccountFailure\(target, reason/);
  assert.match(read('lib/server/codex-responses-websocket.js'), /gate\.observeFailure\([\s\S]{0,300}?applyAccountFailurePolicy\(failedAccount/);
  assert.match(read('lib/server/image-generation-executor.js'), /gate\.observeFailure\([\s\S]{0,300}?applyAccountFailurePolicy\(account, policy/);
});

test('server assembles one gate instance and injects it into every request-path deps object', () => {
  const server = read('lib/server/server.js');
  // 只创建一次（模块内 const），并且用 router 的原始 applier（*AndPersist 会导致重复发布）。
  assert.match(server, /const accountRuntimeGate = getAccountRuntimeGate\(state, \{[\s\S]{0,220}?markProxyAccountFailure,\s*\n\s*markProxyAccountSuccess\s*\n\s*\}\);/);
  assert.doesNotMatch(server, /markProxyAccountFailure: markProxyAccountFailureAndPersist,\s*\n\s*markProxyAccountSuccess: markProxyAccountSuccessAndPersist,\s*\n\s*hub:/);
  // 三处装配：WebUI deps（模型探测/恢复调度）、/v1 推理 deps、codex WS relay deps。
  const injections = server.match(/\n\s+accountRuntimeGate,?\n/g) || [];
  assert.ok(injections.length >= 3, `server.js 必须把门禁注入 WebUI/推理/WS 三处 deps（当前 ${injections.length} 处）`);
});

test('probe failures are reported, never recorded', () => {
  const source = read('lib/server/account-probe-recovery.js');
  assert.match(source, /gate\.describeFailure\(/);
  assert.doesNotMatch(source, /gate\.observeFailure\(/, '探测失败不得走记账路径（只提示）');
});
