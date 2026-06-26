const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_NATIVE_STREAM_COLS,
  DEFAULT_NATIVE_STREAM_ROWS,
  buildProviderEnv,
  buildStartCommand,
  buildResumeCommand,
  collectAssistantReply,
  ensureCodexSessionIndexEntry,
  inferCodexSessionIdFromStateDb,
  inferClaudeCreatedSessionId,
  isOfficialNativeSessionProvider,
  parseNativeStreamEvent
} = require('../lib/server/native-session-chat');

test('native session stream uses a wider default pty size to avoid premature hard wraps', () => {
  assert.equal(DEFAULT_NATIVE_STREAM_COLS, 220);
  assert.equal(DEFAULT_NATIVE_STREAM_ROWS, 32);
});

test('ensureCodexSessionIndexEntry writes a prompt-derived thread_name so the session is not filtered as 未命名会话', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-index-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(hostHome, '.codex'), { recursive: true });

  const written = ensureCodexSessionIndexEntry({
    sessionId: 'codex-session-abc',
    prompt: '帮我重构登录模块\n第二行细节',
    hostHome
  });
  assert.equal(written, true);

  const indexPath = path.join(hostHome, '.codex', 'session_index.jsonl');
  const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.id, 'codex-session-abc');
  assert.equal(entry.thread_name, '帮我重构登录模块'); // 取首个非空行
  assert.ok(entry.thread_name !== '未命名会话' && entry.thread_name !== 'Warmup');

  // 同 id 不重复写
  const writtenAgain = ensureCodexSessionIndexEntry({
    sessionId: 'codex-session-abc',
    prompt: '又一轮',
    hostHome
  });
  assert.equal(writtenAgain, false);
  assert.equal(fs.readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).length, 1);
});

test('inferCodexSessionIdFromStateDb returns newest non-archived thread for cwd, excluding before/old', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-dbinfer-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const codexDir = path.join(hostHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, updated_at_ms INTEGER, archived INTEGER DEFAULT 0);`);
  const ins = db.prepare('INSERT INTO threads (id, cwd, updated_at_ms, archived) VALUES (?, ?, ?, ?)');
  const cwd = '/Users/model/projects/demo';
  ins.run('old-existing', cwd, 1000, 0);       // pre-existing (in beforeSessionIds)
  ins.run('new-newest', cwd, 9000, 0);          // the just-created one
  ins.run('new-older', cwd, 8000, 0);           // newer than start but older than newest
  ins.run('archived-new', cwd, 9500, 1);        // archived -> excluded
  ins.run('other-cwd', '/Users/model/projects/other', 9999, 0); // different cwd -> excluded
  db.close();

  const got = inferCodexSessionIdFromStateDb({
    cwd,
    startedAt: 5000,
    beforeSessionIds: ['old-existing'],
    hostHome
  });
  assert.equal(got, 'new-newest');

  // cwd 不匹配 → 空
  assert.equal(inferCodexSessionIdFromStateDb({ cwd: '/nope', startedAt: 5000, beforeSessionIds: [], hostHome }), '');
  // 全部早于 startedAt → 空
  assert.equal(inferCodexSessionIdFromStateDb({ cwd, startedAt: 100000, beforeSessionIds: ['old-existing'], hostHome }), '');
});

test('ensureCodexSessionIndexEntry refuses to write when no usable title can be derived', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-index-empty-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(hostHome, '.codex'), { recursive: true });

  assert.equal(ensureCodexSessionIndexEntry({ sessionId: 'x', prompt: '   \n  ', hostHome }), false);
  assert.equal(ensureCodexSessionIndexEntry({ sessionId: '', prompt: 'hi', hostHome }), false);
  assert.equal(fs.existsSync(path.join(hostHome, '.codex', 'session_index.jsonl')), false);
});

test('buildResumeCommand builds gemini official resume invocation', () => {
  const command = buildResumeCommand('gemini', {
    sessionId: 'gem-session-id',
    prompt: '你好',
    model: 'gemini-3.1-pro-preview'
  });

  assert.equal(command.commandName, 'gemini');
  assert.deepEqual(command.args, [
    '--resume',
    'gem-session-id',
    '--prompt-interactive',
    '你好',
    '--model',
    'gemini-3.1-pro-preview'
  ]);
});

test('buildResumeCommand uses --session-file when the gemini transcript resolves on disk', () => {
  // gemini 的 --resume 按 cwd→projectHash 发现会话不可靠；能解析到磁盘文件时
  // 改用 --session-file 按绝对路径加载，绕开发现机制。
  const realHomeBackup = process.env.REAL_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-resume-'));
  const sessionId = '334e009d-267c-407d-be2e-253efd0df5ec';
  const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'myproj', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const sessionFile = path.join(chatsDir, `session-2026-05-23T08-17-${sessionId.slice(0, 8)}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ sessionId, projectHash: 'x', kind: 'main' })}\n`);
  process.env.REAL_HOME = tmpHome;
  try {
    const command = buildResumeCommand('gemini', { sessionId, prompt: '继续' });
    assert.equal(command.commandName, 'gemini');
    assert.deepEqual(command.args, ['--session-file', sessionFile, '--prompt-interactive', '继续']);
  } finally {
    if (realHomeBackup === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = realHomeBackup;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('buildStartCommand builds gemini official start invocation with session id', () => {
  const command = buildStartCommand('gemini', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '你好',
    model: 'gemini-2.5-flash'
  });

  assert.equal(command.commandName, 'gemini');
  assert.deepEqual(command.args, [
    '--session-id',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '--prompt-interactive',
    '你好',
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

test('buildResumeCommand builds codex official resume invocation', () => {
  const command = buildResumeCommand('codex', {
    sessionId: 'codex-session-id',
    prompt: 'hello',
    model: 'gpt-5.4'
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    'resume',
    '-m',
    'gpt-5.4',
    'codex-session-id',
    'hello'
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

test('buildResumeCommand builds claude headless stream resume invocation', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '你好',
    model: 'claude-sonnet-4-5'
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '--model',
    'claude-sonnet-4-5',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
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

test('buildStartCommand builds codex official start invocation', () => {
  const command = buildStartCommand('codex', {
    prompt: 'hello',
    model: 'gpt-5.4',
    imagePaths: ['/tmp/input.png']
  });

  assert.equal(command.commandName, 'codex');
  assert.deepEqual(command.args, [
    '-m',
    'gpt-5.4',
    '-i',
    '/tmp/input.png',
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

test('buildStartCommand builds claude headless stream start invocation', () => {
  const command = buildStartCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '你好',
    model: 'claude-sonnet-4-5'
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '--model',
    'claude-sonnet-4-5',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--session-id',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '你好'
  ]);
});

test('buildProviderEnv keeps codex sqlite state shared with host home', () => {
  const profileDir = path.join(os.tmpdir(), '.ai_home', 'profiles', 'codex', '10086');
  const env = buildProviderEnv('codex', profileDir, {});

  assert.equal(env.HOME, os.tmpdir());
  assert.equal(env.USERPROFILE, os.tmpdir());
  assert.equal(env.CODEX_HOME, path.join(profileDir, '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join(os.tmpdir(), '.codex'));
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, undefined);
});

test('buildProviderEnv trusts Gemini workspace for WebUI native headless calls', () => {
  const profileDir = path.join(os.tmpdir(), '.ai_home', 'profiles', 'gemini', '1');
  const env = buildProviderEnv('gemini', profileDir, {});

  assert.equal(env.HOME, os.tmpdir());
  assert.equal(env.GEMINI_CLI_HOME, path.join(profileDir, '.gemini'));
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, path.join(profileDir, '.gemini', 'settings.json'));
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
});

test('buildResumeCommand keeps claude normal resume on the official headless stream path', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '继续',
    stream: true
  });

  assert.equal(command.commandName, 'claude');
  assert.deepEqual(command.args, [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '继续'
  ]);
});

test('official native session provider policy includes codex/claude/gemini/agy', () => {
  assert.equal(isOfficialNativeSessionProvider('codex'), true);
  assert.equal(isOfficialNativeSessionProvider('claude'), true);
  assert.equal(isOfficialNativeSessionProvider('gemini'), true);
  assert.equal(isOfficialNativeSessionProvider('agy'), true);
  assert.equal(isOfficialNativeSessionProvider('openai'), false);
});

test('agy native session builds antigravity CLI start/resume commands', () => {
  // 新会话：--prompt-interactive 跑本轮并续会话；agy 自动生成 conversation id（不预指定）。
  const start = buildStartCommand('agy', { prompt: '你好', model: 'gemini-3-flash', interactiveCli: true });
  assert.equal(start.commandName, 'agy');
  assert.deepEqual(start.args, ['--prompt-interactive', '你好', '--dangerously-skip-permissions', '--model', 'gemini-3-flash']);

  // 恢复：--conversation <id> 续指定会话（同 id 追加，不 fork）。
  const resume = buildResumeCommand('agy', { sessionId: 'conv-123', prompt: '继续', interactiveCli: true });
  assert.equal(resume.commandName, 'agy');
  assert.deepEqual(resume.args, ['--conversation', 'conv-123', '--dangerously-skip-permissions', '--prompt-interactive', '继续']);
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
