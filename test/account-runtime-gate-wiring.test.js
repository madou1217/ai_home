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
  // 只创建一次，并且用 router 的原始 applier（*AndPersist 会导致重复发布）。
  assert.match(server, /const accountRuntimeGate = createAccountRuntimeGate\(\{[\s\S]{0,220}?markProxyAccountFailure,\s*\n\s*markProxyAccountSuccess\s*\n\s*\}\);/);
  assert.equal((server.match(/createAccountRuntimeGate\(/g) || []).length, 1, '门禁只允许在 server 装配处创建一次');
  // 必须早于首次建池：否则启动时那一次池加载的恢复路径只能退回直调账号状态服务。
  assert.ok(
    server.indexOf('const accountRuntimeGate = createAccountRuntimeGate(') < server.indexOf('const state = createProxyServerState('),
    '门禁必须早于 createProxyServerState 创建'
  );
  // 挂到 state 上，供没有 ctx.deps 的深层调用方（模型目录刷新等）取同一实例。
  assert.match(server, /state\.accountRuntimeGate = accountRuntimeGate;/);
  // 装配点：WebUI deps、管理面 deps、/v1 推理 deps、codex WS relay deps、token 刷新 daemon、账号加载。
  const injections = server.match(/\n\s+accountRuntimeGate,?\n/g) || [];
  assert.ok(injections.length >= 6, `server.js 必须把门禁注入 6 处以上 deps（当前 ${injections.length} 处）`);
});

test('every recovery path routes through the gate instead of the state service', () => {
  const files = [
    'lib/server/accounts.js',
    'lib/server/web-ui-router.js',
    'lib/server/token-refresh-daemon.js',
    'lib/server/native-session-chat-failure.js',
    'lib/server/webui-account-routes.js',
    'lib/account/claude-login-recovery.js',
    'lib/account/agy-auth-recovery.js',
    'lib/cli/services/pty/runtime-state-store.js',
    'lib/cli/services/usage/snapshot.js',
    'lib/cli/services/usage/codex-auth-invalid-reconciler.js'
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /observeRecovery\(/, `${file} 的运行态恢复必须走门禁的 observeRecovery`);
  }
  // 事件监听器是唯一的持久化落点：它把恢复事件翻译成 clearRuntimeBlock（含 scope/usageSnapshot）。
  const listener = read('lib/server/account-runtime-event-listeners.js');
  assert.match(listener, /evidence: event\.reason \|\| 'upstream_success'/);
  assert.match(listener, /\.\.\.\(event\.scope \? \{ scope: event\.scope \} : \{\}\)/);
  assert.match(listener, /\.\.\.\(event\.usageSnapshot \? \{ usageSnapshot: event\.usageSnapshot \} : \{\}\)/);
});

test('direct state-service writes only survive as gate-absent fallbacks', () => {
  const files = [
    'lib/server/accounts.js',
    'lib/server/web-ui-router.js',
    'lib/server/token-refresh-daemon.js',
    'lib/server/native-session-chat-failure.js',
    'lib/server/webui-account-routes.js',
    'lib/account/claude-login-recovery.js',
    'lib/account/agy-auth-recovery.js',
    'lib/cli/services/pty/runtime-state-store.js',
    'lib/cli/services/usage/snapshot.js',
    'lib/cli/services/usage/codex-auth-invalid-reconciler.js',
    'lib/cli/services/account/selection.js'
  ];
  for (const file of files) {
    const source = read(file);
    const directWrites = source.match(/accountStateService\.(clearRuntimeBlock|recordRuntimeSuccess|recordRuntimeFailure)\(/g) || [];
    assert.ok(
      source.includes('accountRuntimeGate') || source.includes('createAccountRuntimeGate('),
      `${file} 引用账号状态服务时必须同时接门禁（直写只能作为未装配门禁的兜底）`
    );
    if (directWrites.length > 0) {
      // 兜底必须显式：文件里要能看到「没有门禁才走这里」的分支或注释。
      assert.match(
        source,
        /observeRecovery\(|observeRuntimeState\(|accountRuntimeGate|createAccountRuntimeGate\(/,
        `${file} 的直写必须是门禁缺席时的兜底路径`
      );
    }
  }
  // 门禁与监听器是唯一允许无条件直写运行态的两个模块。
  assert.match(read('lib/server/account-runtime-event-listeners.js'), /accountStateService\.clearRuntimeBlock\(/);
});

test('probe failures are reported, never recorded', () => {
  const source = read('lib/server/account-probe-recovery.js');
  assert.match(source, /gate\.describeFailure\(/);
  assert.doesNotMatch(source, /gate\.observeFailure\(/, '探测失败不得走记账路径（只提示）');
});
