const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendClaudeHookDiagnosticLog,
  appendClaudeToolDiagnosticLog,
  collectClaudeStopHookDiagnostics,
  collectClaudeToolProtocolDiagnostics,
  containsClaudeToolProtocolProblem,
  containsClaudeStopHookJsonValidationError,
  sanitizeClaudeProjectDirName
} = require('../lib/cli/services/pty/claude-hook-diagnostics');

test('containsClaudeStopHookJsonValidationError detects Claude PTY stop hook failure', () => {
  assert.equal(containsClaudeStopHookJsonValidationError('Ran 1 stop hook\nStop hook error: JSON validation failed'), true);
  assert.equal(containsClaudeStopHookJsonValidationError('JSON validation failed'), false);
  assert.equal(containsClaudeStopHookJsonValidationError('Stop hook error: timeout'), false);
});

test('containsClaudeToolProtocolProblem detects Claude tool protocol failures', () => {
  assert.equal(containsClaudeToolProtocolProblem('[Tool use interrupted]'), true);
  assert.equal(containsClaudeToolProtocolProblem('InputValidationError: Read failed'), true);
  assert.equal(containsClaudeToolProtocolProblem('The required parameter `file_path` is missing'), true);
  assert.equal(containsClaudeToolProtocolProblem('Error: String to replace not found in file.'), true);
  assert.equal(containsClaudeToolProtocolProblem('plain output'), false);
});

test('collectClaudeStopHookDiagnostics extracts hook evidence from transcript tail', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-hook-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-05-31T13:35:09.709Z',
      cwd,
      sessionId,
      attachment: {
        type: 'hook_non_blocking_error',
        hookName: 'Stop',
        hookEvent: 'Stop',
        stderr: 'JSON validation failed',
        stdout: '```json\n{"ok":true}\n```',
        exitCode: 1,
        command: 'finish the task',
        durationMs: 6125,
        toolUseID: 'tool-1'
      }
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'stop_hook_summary',
      timestamp: '2026-05-31T13:35:09.712Z',
      cwd,
      sessionId,
      hookCount: 1,
      hookErrors: ['JSON validation failed'],
      hookInfos: [{ command: 'finish the task', durationMs: 6125 }]
    })
  ].join('\n'), 'utf8');

  const diagnostic = collectClaudeStopHookDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-05-31T13:35:00.000Z')
  });

  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.errors.length, 1);
  assert.equal(diagnostic.errors[0].sessionId, sessionId);
  assert.equal(diagnostic.errors[0].stderr, 'JSON validation failed');
  assert.equal(diagnostic.errors[0].stdout, '```json\n{"ok":true}\n```');
  assert.equal(diagnostic.summaries.length, 1);
  assert.equal(diagnostic.scannedFiles[0], transcriptPath);
});

test('collectClaudeToolProtocolDiagnostics extracts tool interruption and missing input evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-tool-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({
      type: 'system',
      timestamp: '2026-05-31T14:18:00.000Z',
      cwd,
      sessionId,
      tools: [{
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }]
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-31T14:19:41.808Z',
      cwd,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }]
      }
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-05-31T14:19:41.810Z',
      cwd,
      sessionId,
      message: {
        role: 'user',
        content: 'InputValidationError: Read failed due to the following issue:\nThe required parameter `file_path` is missing</tool_use_error>'
      }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-31T14:19:46.810Z',
      cwd,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '[Tool use interrupted]' }]
      }
    }),
    JSON.stringify({
      type: 'attachment',
      timestamp: '2026-05-31T14:19:49.810Z',
      cwd,
      sessionId,
      attachment: {
        type: 'goal_status',
        met: false,
        condition: 'verify tool protocol adapter',
        reason: 'No code has been written.'
      }
    })
  ].join('\n'), 'utf8');

  const diagnostic = collectClaudeToolProtocolDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-05-31T14:19:00.000Z')
  });

  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.counts.tool_use_missing_input, 1);
  assert.equal(diagnostic.counts.tool_input_validation_error, 1);
  assert.equal(diagnostic.counts.tool_use_interrupted_text, 1);
  assert.equal(diagnostic.counts.goal_status_unmet, 1);
  const validation = diagnostic.incidents.find((item) => item.type === 'tool_input_validation_error');
  assert.equal(validation.toolName, 'Read');
  assert.deepEqual(validation.missingRequired, ['file_path']);
  const missingInput = diagnostic.incidents.find((item) => item.type === 'tool_use_missing_input');
  assert.equal(missingInput.toolName, 'Read');
  assert.deepEqual(missingInput.knownRequiredKeys, ['file_path']);
  assert.equal(missingInput.requiredSource, 'tool_schema');
  assert.deepEqual(missingInput.missingRequired, ['file_path']);
  assert.equal(diagnostic.scannedFiles[0], transcriptPath);
});

test('collectClaudeToolProtocolDiagnostics derives missing input from arbitrary tool schemas', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-tool-diag-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'system',
      timestamp: '2026-05-31T14:22:00.000Z',
      cwd,
      sessionId,
      message: {
        tools: [{
          type: 'function',
          function: {
            name: 'CustomFetch',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url']
            }
          }
        }]
      }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-31T14:22:41.808Z',
      cwd,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_fetch', name: 'CustomFetch', input: {} }]
      }
    })
  ].join('\n'), 'utf8');

  const diagnostic = collectClaudeToolProtocolDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-05-31T14:22:30.000Z')
  });

  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.counts.tool_use_missing_input, 1);
  assert.equal(diagnostic.latest.toolName, 'CustomFetch');
  assert.deepEqual(diagnostic.latest.knownRequiredKeys, ['url']);
  assert.deepEqual(diagnostic.latest.missingRequired, ['url']);
  assert.equal(diagnostic.latest.requiredSource, 'tool_schema');
});

test('collectClaudeToolProtocolDiagnostics parses validation text for arbitrary tools', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-tool-diag-generic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'user',
    timestamp: '2026-05-31T14:21:41.808Z',
    cwd,
    sessionId,
    message: {
      role: 'user',
      content: 'InputValidationError: CustomFetch failed due to the following issue:\nThe required parameter `url` is missing</tool_use_error>'
    }
  }), 'utf8');

  const diagnostic = collectClaudeToolProtocolDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-05-31T14:21:00.000Z')
  });

  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.counts.tool_input_validation_error, 1);
  assert.equal(diagnostic.counts.tool_use_missing_input, undefined);
  assert.equal(diagnostic.latest.toolName, 'CustomFetch');
  assert.deepEqual(diagnostic.latest.missingRequired, ['url']);
});

test('collectClaudeToolProtocolDiagnostics extracts Claude Edit string mismatch evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-edit-diag-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-02T04:04:31.000Z',
      cwd,
      sessionId,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_edit_1',
          name: 'Edit',
          input: {
            file_path: '/tmp/demo.py',
            old_string: 'print("old")',
            new_string: 'print("new")'
          }
        }]
      }
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-06-02T04:04:33.000Z',
      cwd,
      sessionId,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_edit_1',
          is_error: true,
          content: '<tool_use_error>String to replace not found in file.\nString: print("old")\n(note: Edit also tried swapping \\uXXXX escapes and their characters; neither form matched.)</tool_use_error>'
        }]
      },
      toolUseResult: 'Error: String to replace not found in file.\nString: print("old")'
    })
  ].join('\n'), 'utf8');

  const diagnostic = collectClaudeToolProtocolDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-06-02T04:04:00.000Z')
  });

  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.counts.edit_string_not_found, 1);
  assert.equal(diagnostic.latest.type, 'edit_string_not_found');
  assert.equal(diagnostic.latest.toolName, 'Edit');
  assert.equal(diagnostic.latest.toolUseId, 'toolu_edit_1');
  assert.equal(diagnostic.latest.filePath, '/tmp/demo.py');
  assert.equal(diagnostic.latest.oldStringLength, 12);
  assert.equal(diagnostic.latest.newStringLength, 12);
  assert.match(diagnostic.latest.oldStringHash, /^[a-f0-9]{16}$/);
  assert.equal(diagnostic.latest.triedUnicodeSwap, true);
});

test('collectClaudeToolProtocolDiagnostics does not treat unknown empty-input tools as Read failures', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-tool-diag-unknown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = '/tmp/demo-project';
  const sessionId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDirName = sanitizeClaudeProjectDirName(cwd);
  const projectDir = path.join(root, '.claude', 'projects', projectDirName);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-31T14:20:41.808Z',
    cwd,
    sessionId,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_unknown', name: 'TodoRead', input: {} }]
    }
  }), 'utf8');

  const diagnostic = collectClaudeToolProtocolDiagnostics({
    fs,
    path,
    hostHomeDir: root,
    cwd,
    sinceMs: Date.parse('2026-05-31T14:20:00.000Z')
  });

  assert.equal(diagnostic.found, false);
  assert.equal(diagnostic.counts.tool_use_missing_input, undefined);
});

test('appendClaudeHookDiagnosticLog writes JSONL diagnostic entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-hook-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = appendClaudeHookDiagnosticLog({
    fs,
    path,
    aiHomeDir: root,
    provider: 'claude',
    clientProvider: 'claude',
    relay: {
      kind: 'aih_server',
      baseUrl: 'http://127.0.0.1:8317',
      gateway: true,
      providerMode: 'auto'
    },
    gateway: true,
    cwd: '/tmp/demo-project',
    cliPath: '/usr/local/bin/claude',
    forwardArgs: ['--resume', 'sid'],
    triggerOutput: 'Stop hook error: JSON validation failed',
    diagnostic: {
      found: true,
      latest: { sessionId: 'sid', stderr: 'JSON validation failed' },
      errors: [{ sessionId: 'sid', stderr: 'JSON validation failed' }],
      summaries: [],
      scannedFiles: ['/tmp/session.jsonl']
    },
    nowMs: Date.parse('2026-05-31T13:40:00.000Z')
  });

  assert.equal(result.ok, true);
  const lines = fs.readFileSync(result.logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.kind, 'claude_stop_hook_json_validation');
  assert.equal(entry.provider, 'claude');
  assert.equal(entry.clientProvider, 'claude');
  assert.equal(entry.accountRef, undefined);
  assert.equal(entry.gateway, true);
  assert.deepEqual(entry.relay, {
    kind: 'aih_server',
    baseUrl: 'http://127.0.0.1:8317',
    gateway: true,
    providerMode: 'auto'
  });
  assert.equal(entry.latest.sessionId, 'sid');
  assert.deepEqual(entry.args, ['--resume', 'sid']);
});

test('appendClaudeToolDiagnosticLog writes JSONL diagnostic entry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-tool-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = appendClaudeToolDiagnosticLog({
    fs,
    path,
    aiHomeDir: root,
    cwd: '/tmp/demo-project',
    accountRef: 'acct_11111111111111111111',
    cliPath: '/usr/local/bin/claude',
    forwardArgs: ['--resume', 'sid'],
    triggerOutput: '[Tool use interrupted]',
    diagnostic: {
      found: true,
      latest: { sessionId: 'sid', type: 'tool_use_interrupted_text' },
      counts: { tool_use_interrupted_text: 1 },
      incidents: [{ sessionId: 'sid', type: 'tool_use_interrupted_text' }],
      scannedFiles: ['/tmp/session.jsonl']
    },
    nowMs: Date.parse('2026-05-31T14:40:00.000Z')
  });

  assert.equal(result.ok, true);
  const lines = fs.readFileSync(result.logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.kind, 'claude_tool_protocol');
  assert.equal(entry.accountRef, 'acct_11111111111111111111');
  assert.equal(entry.counts.tool_use_interrupted_text, 1);
  assert.deepEqual(entry.args, ['--resume', 'sid']);
});
