const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_NATIVE_STREAM_COLS,
  DEFAULT_NATIVE_STREAM_ROWS,
  buildStartCommand,
  buildResumeCommand,
  collectAssistantReply,
  inferClaudeCreatedSessionId,
  parseNativeStreamEvent
} = require('../lib/server/native-session-chat');

test('native session stream uses a wider default pty size to avoid premature hard wraps', () => {
  assert.equal(DEFAULT_NATIVE_STREAM_COLS, 220);
  assert.equal(DEFAULT_NATIVE_STREAM_ROWS, 32);
});

test('buildResumeCommand builds gemini native resume invocation', () => {
  const command = buildResumeCommand('gemini', {
    sessionId: 'gem-session-id',
    prompt: '你好',
    model: 'gemini-3.1-pro-preview'
  });

  assert.equal(command.commandName, 'gemini');
  assert.deepEqual(command.args, [
    '--resume',
    'gem-session-id',
    '--prompt',
    '你好',
    '--output-format',
    'json',
    '--model',
    'gemini-3.1-pro-preview'
  ]);
});

test('buildStartCommand builds gemini native start invocation', () => {
  const command = buildStartCommand('gemini', {
    prompt: '你好',
    model: 'gemini-2.5-flash',
    stream: true
  });

  assert.equal(command.commandName, 'gemini');
  assert.deepEqual(command.args, [
    '--prompt',
    '你好',
    '--output-format',
    'stream-json',
    '--model',
    'gemini-2.5-flash'
  ]);
});

test('buildResumeCommand builds gemini interactive resume invocation for slash commands', () => {
  const command = buildResumeCommand('gemini', {
    sessionId: 'gem-session-id',
    model: 'gemini-3.1-pro-preview',
    interactiveCli: true
  });

  assert.equal(command.commandName, 'gemini');
  assert.deepEqual(command.args, [
    '--resume',
    'gem-session-id',
    '--model',
    'gemini-3.1-pro-preview'
  ]);
});

test('buildResumeCommand builds codex exec resume invocation', () => {
  const command = buildResumeCommand('codex', {
    sessionId: 'codex-session-id',
    prompt: 'hello',
    model: 'gpt-5.4',
    outputLastMessagePath: '/tmp/codex-last.txt'
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    'exec',
    'resume',
    '-m',
    'gpt-5.4',
    'codex-session-id',
    'hello',
    '--output-last-message',
    '/tmp/codex-last.txt',
    '--json'
  ]);
});

test('buildResumeCommand builds codex interactive resume invocation for slash commands', () => {
  const command = buildResumeCommand('codex', {
    sessionId: 'codex-session-id',
    model: 'gpt-5.4',
    interactiveCli: true,
    imagePaths: ['/tmp/one.png', '/tmp/two.png']
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    'resume',
    '-m',
    'gpt-5.4',
    '-i',
    '/tmp/one.png',
    '-i',
    '/tmp/two.png',
    'codex-session-id'
  ]);
});

test('buildResumeCommand builds claude print resume invocation', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '你好',
    model: 'claude-sonnet-4-5'
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '-p',
    '--output-format',
    'json',
    '--model',
    'claude-sonnet-4-5',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '你好'
  ]);
});

test('buildResumeCommand builds claude interactive resume invocation for slash commands', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    model: 'claude-sonnet-4-5',
    interactiveCli: true
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '--model',
    'claude-sonnet-4-5',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654'
  ]);
});

test('buildStartCommand builds codex native start invocation', () => {
  const command = buildStartCommand('codex', {
    prompt: 'hello',
    model: 'gpt-5.4',
    outputLastMessagePath: '/tmp/codex-last.txt',
    imagePaths: ['/tmp/input.png']
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-m',
    'gpt-5.4',
    '-i',
    '/tmp/input.png',
    '--output-last-message',
    '/tmp/codex-last.txt',
    'hello'
  ]);
});

test('buildStartCommand builds codex interactive start invocation for slash commands', () => {
  const command = buildStartCommand('codex', {
    model: 'gpt-5.4',
    interactiveCli: true,
    imagePaths: ['/tmp/clipboard.png']
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    '-m',
    'gpt-5.4',
    '-i',
    '/tmp/clipboard.png'
  ]);
});

test('buildResumeCommand builds claude stream resume invocation with verbose enabled', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '继续',
    stream: true
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '继续'
  ]);
});

test('collectAssistantReply extracts assistant additions after native resume completes', () => {
  const beforeMessages = [
    { role: 'user', content: 'old-user' },
    { role: 'assistant', content: 'old-assistant' }
  ];
  const afterMessages = [
    ...beforeMessages,
    { role: 'user', content: 'new-user' },
    { role: 'assistant', content: 'new-assistant-1' },
    { role: 'assistant', content: 'new-assistant-2' }
  ];

  assert.equal(
    collectAssistantReply(beforeMessages, afterMessages),
    'new-assistant-1\n\nnew-assistant-2'
  );
});

test('parseNativeStreamEvent emits codex session-created from session_meta payload id', () => {
  const state = { content: '', sessionId: '' };
  const event = parseNativeStreamEvent(
    'codex',
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: '019d7bae-4dd5-73f2-b2bd-8125899885cb'
      }
    }),
    state
  );

  assert.deepEqual(event, {
    type: 'session-created',
    sessionId: '019d7bae-4dd5-73f2-b2bd-8125899885cb'
  });
  assert.equal(state.sessionId, '019d7bae-4dd5-73f2-b2bd-8125899885cb');
});

test('parseNativeStreamEvent still supports legacy codex thread.started session ids', () => {
  const state = { content: '', sessionId: '' };
  const event = parseNativeStreamEvent(
    'codex',
    JSON.stringify({
      type: 'thread.started',
      thread_id: 'legacy-thread-id'
    }),
    state
  );

  assert.deepEqual(event, {
    type: 'session-created',
    sessionId: 'legacy-thread-id'
  });
  assert.equal(state.sessionId, 'legacy-thread-id');
});

test('inferClaudeCreatedSessionId finds the newly persisted claude session from host project store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-claude-infer-'));
  const originalRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = root;

  try {
    const projectDirName = 'Users-model-projects-feature-ai-home';
    const projectDir = path.join(root, '.claude', 'projects', projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'old-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        message: { content: '旧会话' }
      })}\n`,
      'utf8'
    );

    const startedAt = Date.now();
    const nextSessionId = 'claude-session-created-2';
    fs.writeFileSync(
      path.join(projectDir, `${nextSessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          message: { content: '请记住这个 Claude 会话' }
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '已经记住。' }]
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const resolvedSessionId = await inferClaudeCreatedSessionId(projectDirName, {
      beforeSessionIds: ['old-session'],
      startedAt,
      prompt: '请记住这个 Claude 会话',
      timeoutMs: 200
    });

    assert.equal(resolvedSessionId, nextSessionId);
  } finally {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
