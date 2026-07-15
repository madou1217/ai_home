'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CODEX_INTERACTIVE_SOURCE_KINDS,
  isCodexInteractiveSessionSource,
  isCodexSubagentThread,
  isCodexTopLevelInteractiveThread,
  isCodexWorktreeProjectPath,
  resolveCodexThreadListSourceKinds
} = require('../lib/sessions/codex-visible-session-policy');

test('Codex visible session policy matches native interactive resume sources', () => {
  assert.deepEqual(CODEX_INTERACTIVE_SOURCE_KINDS, ['cli', 'vscode']);
  assert.equal(isCodexInteractiveSessionSource('cli'), true);
  assert.equal(isCodexInteractiveSessionSource('vscode'), true);
  assert.equal(isCodexInteractiveSessionSource('exec'), false);
  assert.equal(isCodexInteractiveSessionSource('{"subagent":"review"}'), false);
});

test('Codex visible session policy preserves source-less legacy rollouts', () => {
  assert.equal(isCodexInteractiveSessionSource(''), true);
  assert.equal(isCodexInteractiveSessionSource(null), true);
});

test('Codex thread list defaults to interactive sources but respects explicit source filters', () => {
  assert.deepEqual(resolveCodexThreadListSourceKinds(), ['cli', 'vscode']);
  assert.deepEqual(resolveCodexThreadListSourceKinds([]), ['cli', 'vscode']);
  assert.deepEqual(resolveCodexThreadListSourceKinds(['exec']), ['exec']);
  assert.deepEqual(resolveCodexThreadListSourceKinds(['CLI', 'cli', 'vscode']), ['cli', 'vscode']);
});

test('Codex top-level policy recognizes every persisted subagent classification', () => {
  const edgeChildren = new Set(['edge-child']);
  assert.equal(isCodexSubagentThread({ id: 'edge-child', source: 'cli' }, edgeChildren), true);
  assert.equal(isCodexSubagentThread({ id: 'thread-source', source: 'cli', thread_source: 'subagent' }), true);
  assert.equal(isCodexSubagentThread({ id: 'parent-link', source: 'cli', parentThreadId: 'parent' }), true);
  assert.equal(isCodexSubagentThread({ id: 'json-source', source: '{"subagent":"review"}' }), true);
  assert.equal(isCodexSubagentThread({ id: 'main', source: 'cli' }), false);
  assert.equal(isCodexTopLevelInteractiveThread({ id: 'main', source: 'cli' }), true);
  assert.equal(isCodexTopLevelInteractiveThread({ id: 'exec', source: 'exec' }), false);
  assert.equal(isCodexTopLevelInteractiveThread({
    id: 'worktree',
    source: 'vscode',
    cwd: '/Users/model/.codex/worktrees/abc/project'
  }), false);
});

test('Codex visible session policy recognizes worktree paths across platforms', () => {
  assert.equal(isCodexWorktreeProjectPath('/Users/model/.codex/worktrees/abc/project'), true);
  assert.equal(isCodexWorktreeProjectPath('C:\\Users\\model\\.codex\\worktrees\\abc\\project'), true);
  assert.equal(isCodexWorktreeProjectPath('/Users/model/projects/ai_home'), false);
});
