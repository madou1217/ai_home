const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeApprovalMode,
  approvalModeNeedsBridge,
  claudeApprovalArgs,
  grokApprovalArgs,
  buildClaudeApprovalMcpConfig
} = require('../lib/server/native-approval-modes');
const {
  registerApprovalRequest,
  decideApproval,
  cancelApprovalsForRun,
  getPendingApprovalPromptForRun
} = require('../lib/server/native-approval-bridge');

// 会话级审批模式(P3):模式映射纯函数 + 审批桥挂起/决策往返。

test('审批模式归一与 claude 参数映射', () => {
  assert.equal(normalizeApprovalMode('CONFIRM'), 'confirm');
  assert.equal(normalizeApprovalMode('随便'), 'bypass');
  assert.equal(approvalModeNeedsBridge('bypass'), false);
  assert.equal(approvalModeNeedsBridge('plan'), true);

  assert.deepEqual(claudeApprovalArgs('bypass', '{}'), []);
  const confirmArgs = claudeApprovalArgs('confirm', '{"mcpServers":{}}');
  assert.deepEqual(confirmArgs.slice(0, 4), ['--permission-mode', 'default', '--permission-prompt-tool', 'mcp__aih__approve']);
  const planArgs = claudeApprovalArgs('plan', '');
  assert.equal(planArgs[1], 'plan');
  assert.ok(!planArgs.includes('--mcp-config'), '无 config 时不带 --mcp-config');

  const config = JSON.parse(buildClaudeApprovalMcpConfig({
    toolPath: '/x/tool.js', approvalUrl: 'http://127.0.0.1:9527/a', runId: 'r1', nodePath: '/usr/bin/node'
  }));
  assert.equal(config.mcpServers.aih.command, '/usr/bin/node');
  assert.equal(config.mcpServers.aih.env.AIH_RUN_ID, 'r1');
});

test('grok approval args map canonical modes to native permission modes', () => {
  assert.deepEqual(grokApprovalArgs('bypass'), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(grokApprovalArgs('confirm'), ['--permission-mode', 'default']);
  assert.deepEqual(grokApprovalArgs('plan'), ['--permission-mode', 'plan']);
});

test('审批桥:登记→prompt 可见→决策回填→清理;run 结束批量 deny', () => {
  const decisions = [];
  const entry = registerApprovalRequest(
    { runId: 'run-A', toolName: 'Write', input: { file_path: '/tmp/x' }, toolUseId: 't1' },
    (decision) => decisions.push(decision)
  );
  // detached 恢复视角:/chat/runs 的 activePrompt 形状
  const prompt = getPendingApprovalPromptForRun('run-A');
  assert.equal(prompt.kind, 'approval');
  assert.equal(prompt.approvalId, entry.approvalId);
  assert.match(prompt.question, /Write/);
  assert.equal(prompt.options.length, 2);

  // allow → respond 收到 allow + updatedInput 原样;pending 清空
  const decided = decideApproval(entry.approvalId, 'allow');
  assert.equal(decided.approvalId, entry.approvalId);
  assert.equal(decisions[0].behavior, 'allow');
  assert.deepEqual(decisions[0].updatedInput, { file_path: '/tmp/x' });
  assert.equal(getPendingApprovalPromptForRun('run-A'), null);
  // 重复决策幂等
  assert.equal(decideApproval(entry.approvalId, 'deny'), null);

  // run 结束批量 deny
  const late = [];
  registerApprovalRequest({ runId: 'run-B', toolName: 'Bash', input: {} }, (d) => late.push(d));
  registerApprovalRequest({ runId: 'run-B', toolName: 'Write', input: {} }, (d) => late.push(d));
  assert.equal(cancelApprovalsForRun('run-B', 'aborted'), 2);
  assert.equal(late.length, 2);
  assert.ok(late.every((d) => d.behavior === 'deny'));
  assert.equal(getPendingApprovalPromptForRun('run-B'), null);
});
