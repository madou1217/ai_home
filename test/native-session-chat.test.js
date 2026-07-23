const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_NATIVE_STREAM_COLS,
  DEFAULT_NATIVE_STREAM_ROWS,
  buildProviderEnv,
  buildPtyInputChunks,
  buildStartCommand,
  buildResumeCommand,
  applyProviderConfigDirArgs,
  classifyNativeSessionFailure,
  classifyNativeAccountRuntimeBlocker,
  collectAssistantReply,
  ensureCodexSessionIndexEntry,
  inferCodexSessionIdFromStateDb,
  inferClaudeCreatedSessionId,
  isOfficialNativeSessionProvider,
  parseNativeStreamEvent,
  recordNativeAccountRuntimeBlocker,
  resolveNativeCliLaunch,
  spawnNativeSessionStream,
  startAgyColdAfterQuiesce,
  shouldScanNativeRuntimeBlockerOutput
} = require('../lib/server/native-session-chat');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { writeServerConfig } = require('../lib/server/server-config-store');

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('native session stream uses a wider default pty size to avoid premature hard wraps', () => {
  assert.equal(DEFAULT_NATIVE_STREAM_COLS, 220);
  assert.equal(DEFAULT_NATIVE_STREAM_ROWS, 32);
});

test('native session pty input writes submit key as a separate chunk', () => {
  assert.deepEqual(buildPtyInputChunks('hello'), ['hello', '\r']);
  assert.deepEqual(buildPtyInputChunks('hello\r'), ['hello', '\r']);
  assert.deepEqual(buildPtyInputChunks('hello', { appendNewline: false }), ['hello']);
  assert.deepEqual(buildPtyInputChunks('line one\nline two'), ['line one\rline two', '\r']);
});

test('AGY cold spawn reserves a writer generation and waits for shared quiescence', async () => {
  const quiescence = createDeferred();
  const lifecycle = [];
  const lease = { accountRef: 'acct_agy', generation: 2 };
  const handle = startAgyColdAfterQuiesce({
    accountRef: 'acct_agy',
    warmPool: {
      reserveWriter(accountRef) {
        lifecycle.push(`reserve:${accountRef}`);
        return lease;
      },
      waitForQuiescence(accountRef) {
        lifecycle.push(`wait:${accountRef}`);
        return quiescence.promise;
      },
      releaseWriter(releasedLease) {
        lifecycle.push(`release:${releasedLease.generation}`);
        return true;
      }
    },
    coldSpawn(reservedLease) {
      lifecycle.push(`spawn:${reservedLease.generation}`);
      return {
        child: { pid: 202 },
        done: Promise.resolve({ content: 'ok', sessionId: 'session-1' }),
        abort() {}
      };
    }
  });

  assert.deepEqual(lifecycle, ['reserve:acct_agy', 'wait:acct_agy']);
  assert.equal(handle.child, null);

  quiescence.resolve();
  assert.deepEqual(await handle.done, { content: 'ok', sessionId: 'session-1' });
  assert.deepEqual(lifecycle, ['reserve:acct_agy', 'wait:acct_agy', 'spawn:2']);
  assert.equal(handle.child.pid, 202);
});

test('native session CLI resolution uses the runtime env PATH', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const opencodeBin = path.join(binDir, 'opencode');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(opencodeBin, '#!/bin/sh\necho 1.0.0\n', 'utf8');
  fs.chmodSync(opencodeBin, 0o755);

  const launch = resolveNativeCliLaunch('opencode', {
    env: {
      PATH: binDir,
      AIH_OPENCODE_RESOLVE_LATEST: '0'
    }
  });

  assert.equal(launch.command, opencodeBin);
  assert.deepEqual(launch.prefixArgs, []);
});

test('native session CLI resolution falls back to app node_modules bin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-cli-app-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'node_modules', '.bin');
  const codexBin = path.join(binDir, 'codex');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(codexBin, '#!/bin/sh\necho codex\n', 'utf8');
  fs.chmodSync(codexBin, 0o755);

  const launch = resolveNativeCliLaunch('codex', {
    appRoot: root,
    env: {
      PATH: '',
      AIH_CODEX_RESOLVE_LATEST: '0'
    },
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' })
  });

  assert.equal(launch.command, codexBin);
  assert.deepEqual(launch.prefixArgs, []);
});

test('native session classifies provider auth failures from interactive terminal output', () => {
  const blocker = classifyNativeAccountRuntimeBlocker(
    'codex',
    'unexpected status 401 Unauthorized: Incorrect API key provided: yesboss-****udou'
  );

  assert.ok(blocker);
  assert.equal(blocker.status, 'auth_invalid');
  assert.equal(blocker.reason, 'upstream_401');
  assert.equal(blocker.runtimeState.lastFailureKind, 'auth_invalid');
  assert.ok(Number(blocker.runtimeState.authInvalidUntil) > Date.now());
});

test('native session preserves a non-zero exit code when the process produced no output', () => {
  const failure = classifyNativeSessionFailure('codex', '', { exitCode: 1 });

  assert.equal(failure.code, 'native_session_failed');
  assert.equal(failure.message, 'native_session_failed_exit_1');
});

test('native session preserves an existing structured failure code', () => {
  const error = new Error('native runtime blocked');
  error.code = 'native_runtime_blocked';

  const failure = classifyNativeSessionFailure('codex', error);

  assert.equal(failure.code, 'native_runtime_blocked');
  assert.equal(failure.message, 'native runtime blocked');
});

test('native session classifies Claude login-missing headless output as auth invalid', () => {
  const blocker = classifyNativeAccountRuntimeBlocker(
    'claude',
    '{"error":"authentication_failed"} Not logged in · Please run /login'
  );

  assert.ok(blocker);
  assert.equal(blocker.provider, 'claude');
  assert.equal(blocker.status, 'auth_invalid');
  assert.equal(blocker.reason, 'claude_not_logged_in');
  assert.equal(blocker.runtimeState.lastFailureKind, 'auth_invalid');
});

test('native session classifies Antigravity login method prompt as auth invalid', () => {
  const blocker = classifyNativeAccountRuntimeBlocker(
    'agy',
    'Welcome to the Antigravity CLI. You are currently not signed in. Select login method: 1. Google OAuth'
  );

  assert.ok(blocker);
  assert.equal(blocker.provider, 'agy');
  assert.equal(blocker.status, 'auth_invalid');
  assert.equal(blocker.reason, 'agy_not_signed_in');
  assert.equal(blocker.runtimeState.lastFailureKind, 'auth_invalid');
});

test('native session only scans runtime blockers from trusted failure surfaces', () => {
  assert.equal(shouldScanNativeRuntimeBlockerOutput({}), false);
  assert.equal(shouldScanNativeRuntimeBlockerOutput({ explicitError: false }), false);
  assert.equal(shouldScanNativeRuntimeBlockerOutput({ interactiveCli: false, exitCode: 0 }), false);
  assert.equal(shouldScanNativeRuntimeBlockerOutput({ interactiveCli: true, exitCode: 0 }), true);
  assert.equal(shouldScanNativeRuntimeBlockerOutput({ explicitError: true, exitCode: 0 }), true);
  assert.equal(shouldScanNativeRuntimeBlockerOutput({ interactiveCli: false, exitCode: 1 }), true);
});

test('native session runtime blocker preserves api-key auth mode for account pool gating', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-runtime-block-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '2',
    identitySeed: 'api:codex:runtime-blocker'
  }).accountRef;
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENAI_API_KEY: 'sk-test' });

  const blocker = classifyNativeAccountRuntimeBlocker(
    'codex',
    'unexpected status 401 Unauthorized: Incorrect API key provided: sk-****test'
  );
  const events = [];
  const persisted = recordNativeAccountRuntimeBlocker({
    provider: 'codex',
    accountRef,
    aiHomeDir,
    accountRuntimeEventHub: {
      emit(type, event) {
        events.push({ type, event });
        return [true];
      }
    }
  }, blocker);

  assert.equal(persisted, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].event.baseState.authMode, 'api-key');
  assert.equal(events[0].event.baseState.apiKeyMode, true);
});

test('native session runtime blocker falls back when hub does not persist', () => {
  const blocker = classifyNativeAccountRuntimeBlocker(
    'agy',
    'Welcome to the Antigravity CLI. You are currently not signed in. Select login method: 1. Google OAuth'
  );
  const writes = [];
  const accountRef = 'acct_0123456789abcdef0123';
  const persisted = recordNativeAccountRuntimeBlocker({
    provider: 'agy',
    accountRef,
    accountRuntimeEventHub: {
      emit() {
        return [false];
      }
    },
    accountStateService: {
      recordRuntimeFailure(capturedAccountRef, provider, runtimeState, baseState) {
        writes.push({ provider, accountRef: capturedAccountRef, runtimeState, baseState });
        return true;
      }
    }
  }, blocker);

  assert.equal(persisted, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].provider, 'agy');
  assert.equal(writes[0].accountRef, accountRef);
  assert.equal(writes[0].runtimeState.lastFailureReason, 'agy_not_signed_in');
});

test('native session runtime blocker does not treat non-persistence listeners as persisted', () => {
  const blocker = classifyNativeAccountRuntimeBlocker(
    'agy',
    'Welcome to the Antigravity CLI. You are currently not signed in. Select login method: 1. Google OAuth'
  );
  const persisted = recordNativeAccountRuntimeBlocker({
    provider: 'agy',
    accountRef: 'acct_0123456789abcdef0123',
    accountRuntimeEventHub: {
      emit() {
        return [false, true];
      }
    }
  }, blocker);

  assert.equal(persisted, false);
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

test('inferCodexSessionIdFromStateDb matches Windows long cwd from Codex state', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-dbinfer-win-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const codexDir = path.join(hostHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, updated_at_ms INTEGER, archived INTEGER DEFAULT 0);`);
  db.prepare('INSERT INTO threads (id, cwd, updated_at_ms, archived) VALUES (?, ?, ?, ?)')
    .run('win-cwd-thread', '\\\\?\\C:\\Users\\madou\\projects\\feature\\ai_home', 9000, 0);
  db.close();

  const got = inferCodexSessionIdFromStateDb({
    cwd: '/mnt/c/Users/madou/projects/feature/ai_home',
    startedAt: 5000,
    beforeSessionIds: [],
    hostHome
  });
  assert.equal(got, 'win-cwd-thread');
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
  // webUI 非交互续会话走 headless：codex exec --json ... resume <id> <prompt>
  // headless 清空 mcp_servers（消除 AWS 死路径 MCP 的 120s 挂死尾部风险，见 CODEX_HEADLESS_EXEC_ARGS）
  assert.deepEqual(command.args, [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
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
  // P2c 新契约:claude headless 一律 --input-format stream-json(prompt 经 stdin 消息送入,
  // 不再位置参数),stdin 常开支撑 mid-run steer。
  assert.deepEqual(command.args, [
    '--model',
    'claude-sonnet-4-5',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654'
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

test('buildResumeCommand builds opencode interactive resume invocation for slash commands', () => {
  const command = buildResumeCommand('opencode', {
    sessionId: 'ses-opencode-real',
    model: 'opencode-go/glm-5.2',
    interactiveCli: true
  });

  assert.equal(command.commandName, 'opencode');
  assert.deepEqual(command.args, [
    '--model',
    'opencode-go/glm-5.2',
    '--session',
    'ses-opencode-real'
  ]);
});

test('buildStartCommand builds codex official start invocation', () => {
  const command = buildStartCommand('codex', {
    prompt: 'hello',
    model: 'gpt-5.4',
    imagePaths: ['/tmp/input.png']
  });

  assert.equal(command.commandName, 'codex');
  // webUI 非交互新会话走 headless：codex exec --json ... <prompt>
  // headless 清空 mcp_servers（消除 AWS 死路径 MCP 的 120s 挂死尾部风险，见 CODEX_HEADLESS_EXEC_ARGS）
  assert.deepEqual(command.args, [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
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
  // P2c:headless 一律 stream-json 输入(prompt 走 stdin 消息)。
  assert.deepEqual(command.args, [
    '--model',
    'claude-sonnet-4-5',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--session-id',
    '3f042998-5ab2-4ad4-8831-183c28b13654',
    '--input-format',
    'stream-json'
  ]);
});

test('buildStartCommand builds opencode headless run invocation', () => {
  const command = buildStartCommand('opencode', {
    prompt: 'hello',
    model: 'opencode-go/glm-5.2',
    projectPath: '/repo/project'
  });

  assert.equal(command.commandName, 'opencode');
  assert.deepEqual(command.args, [
    'run',
    '--format',
    'json',
    '--dangerously-skip-permissions',
    '--model',
    'opencode-go/glm-5.2',
    '--dir',
    '/repo/project',
    'hello'
  ]);
});

test('qoder providers use native headless stream commands', () => {
  assert.equal(isOfficialNativeSessionProvider('qoder'), true);
  assert.equal(isOfficialNativeSessionProvider('qodercn'), true);
  assert.deepEqual(buildStartCommand('qodercn', {
    sessionId: 'qoder-session',
    prompt: 'hello',
    model: 'Qwen3.8-Max-Preview'
  }), {
    commandName: 'qodercn',
    args: [
      '--model',
      'Qwen3.8-Max-Preview',
      '--print',
      '--output-format',
      'stream-json',
      '--session-id',
      'qoder-session',
      'hello'
    ]
  });
  assert.deepEqual(buildResumeCommand('qoder', {
    sessionId: 'qoder-session',
    prompt: 'again'
  }), {
    commandName: 'qoder',
    args: ['--print', '--output-format', 'stream-json', '--resume', 'qoder-session', 'again']
  });
});

test('applyProviderConfigDirArgs uses the centralized provider registry flag', () => {
  assert.deepEqual(
    applyProviderConfigDirArgs('qodercn', ['--print', 'hello'], 'C:\\aih\\qoder-cn-account'),
    ['--config-dir', 'C:\\aih\\qoder-cn-account', '--print', 'hello']
  );
  assert.deepEqual(
    applyProviderConfigDirArgs('claude', ['--print', 'hello'], 'C:\\aih\\claude-account'),
    ['--print', 'hello']
  );
});

test('parseNativeStreamEvent parses qoder stream-json like claude protocol events', () => {
  const state = { content: '' };
  assert.deepEqual(parseNativeStreamEvent('qodercn', JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'qoder-session'
  }), state), { type: 'session-created', sessionId: 'qoder-session' });
  assert.deepEqual(parseNativeStreamEvent('qodercn', JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello' }] }
  }), state), [{ type: 'delta', delta: 'hello' }]);
  assert.deepEqual(parseNativeStreamEvent('qodercn', JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'hello'
  }), state), { type: 'result', content: 'hello' });
});

test('Grok native session commands use streaming JSON and exact resume ids', () => {
  assert.equal(isOfficialNativeSessionProvider('grok'), true);
  assert.deepEqual(buildStartCommand('grok', {
    prompt: 'hello',
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'grok-code-fast-1'
  }), {
    commandName: 'grok',
    args: [
      '--single', 'hello', '--output-format', 'streaming-json',
      '--session-id', '11111111-1111-4111-8111-111111111111',
      '--model', 'grok-code-fast-1'
    ]
  });
  assert.deepEqual(buildResumeCommand('grok', {
    prompt: 'continue',
    sessionId: '11111111-1111-4111-8111-111111111111'
  }), {
    commandName: 'grok',
    args: [
      '--single', 'continue', '--output-format', 'streaming-json',
      '--resume', '11111111-1111-4111-8111-111111111111'
    ]
  });
});

test('parseNativeStreamEvent maps Grok streaming JSON events', () => {
  const state = { content: '', sessionId: '' };
  assert.deepEqual(parseNativeStreamEvent('grok', JSON.stringify({ type: 'thought', data: 'check' }), state), {
    type: 'thinking', thinking: 'check'
  });
  assert.deepEqual(parseNativeStreamEvent('grok', JSON.stringify({ type: 'text', data: 'OK' }), state), {
    type: 'delta', delta: 'OK'
  });
  assert.deepEqual(parseNativeStreamEvent('grok', JSON.stringify({
    type: 'end', sessionId: '11111111-1111-4111-8111-111111111111'
  }), state), [
    { type: 'session-created', sessionId: '11111111-1111-4111-8111-111111111111' },
    { type: 'result', content: 'OK' }
  ]);
});

test('classifyNativeSessionFailure marks revoked Grok OAuth as reauthentication required', () => {
  const failure = classifyNativeAccountRuntimeBlocker('grok', 'invalid_grant: Your session has expired. Run `grok login` to sign in again.');
  assert.equal(failure.status, 'auth_invalid');
  assert.equal(failure.reason, 'auth_invalid_reauth_required');
});

test('buildProviderEnv keeps codex sqlite state shared with host home', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-codex-host-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const aiHomeDir = path.join(hostHome, '.ai_home');
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '10086',
    identitySeed: 'oauth:codex:native-env@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    auth: { tokens: { refresh_token: 'refresh-token' } }
  });
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codex', accountRef);
  const env = buildProviderEnv('codex', runtimeDir, {
    HOME: hostHome,
    OPENAI_API_KEY: 'host-key-must-not-leak',
    OPENAI_BASE_URL: 'https://host.example.com/v1'
  }, { aiHomeDir, accountRef });

  assert.equal(env.HOME, hostHome);
  assert.equal(env.USERPROFILE, hostHome);
  assert.equal(env.CODEX_HOME, path.join(runtimeDir, '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join(hostHome, '.codex'));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, undefined);
});

test('buildProviderEnv loads API-key credentials only from the accountRef DB record', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-codex-api-key-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const aiHomeDir = path.join(hostHome, '.ai_home');
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '2',
    identitySeed: 'api_key:codex:https://account.example.com/v1:db-key'
  }).accountRef;
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    OPENAI_API_KEY: 'db-key',
    OPENAI_BASE_URL: 'https://account.example.com/v1'
  });
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codex', accountRef);

  const env = buildProviderEnv('codex', runtimeDir, {
    HOME: hostHome,
    OPENAI_API_KEY: 'host-key',
    OPENAI_BASE_URL: 'https://host.example.com/v1'
  }, { aiHomeDir, accountRef });

  assert.equal(env.OPENAI_API_KEY, 'db-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://account.example.com/v1');
  assert.equal(env.CODEX_HOME, path.join(hostHome, '.codex'));
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('buildProviderEnv relays Claude OAuth by accountRef and keeps ~/.claude authoritative', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-claude-oauth-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const aiHomeDir = path.join(hostHome, '.ai_home');
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '9',
    identitySeed: 'oauth:claude:native-env@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh'
      }
    }
  });
  writeServerConfig({ host: '127.0.0.1', port: 9527, apiKey: 'gateway-key' }, { fs, aiHomeDir });

  const env = buildProviderEnv('claude', hostHome, {
    HOME: hostHome,
    ANTHROPIC_API_KEY: 'host-key-must-not-leak',
    ANTHROPIC_CUSTOM_HEADERS: 'x-account-ref: wrong'
  }, { aiHomeDir, accountRef });

  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(hostHome, '.claude'));
  assert.equal(env.ANTHROPIC_API_KEY, 'gateway-key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, `x-account-ref: ${accountRef}`);
  assert.equal(fs.existsSync(path.join(hostHome, '.claude', '.credentials.json')), false);
});

test('buildProviderEnv trusts Gemini workspace for WebUI native headless calls', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-gemini-host-'));
  t.after(() => fs.rmSync(hostHome, { recursive: true, force: true }));
  const aiHomeDir = path.join(hostHome, '.ai_home');
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    cliAccountId: '1',
    identitySeed: 'oauth:gemini:native-env@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthCreds: { refresh_token: 'refresh-token' }
  });
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'gemini', accountRef);
  const env = buildProviderEnv('gemini', runtimeDir, { HOME: hostHome }, { aiHomeDir, accountRef });

  assert.equal(env.HOME, hostHome);
  assert.equal(env.GEMINI_CLI_HOME, path.join(runtimeDir, '.gemini'));
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, path.join(runtimeDir, '.gemini', 'settings.json'));
  assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
});

test('buildResumeCommand keeps claude normal resume on the official headless stream path', () => {
  const command = buildResumeCommand('claude', {
    sessionId: '3f042998-5ab2-4ad4-8831-183c28b13654',
    prompt: '继续',
    stream: true
  });

  assert.equal(command.commandName, 'claude');
  // P2c:headless 一律 stream-json 输入。
  assert.deepEqual(command.args, [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--resume',
    '3f042998-5ab2-4ad4-8831-183c28b13654'
  ]);
});

test('official native session provider policy includes codex/claude/gemini/agy/opencode', () => {
  assert.equal(isOfficialNativeSessionProvider('codex'), true);
  assert.equal(isOfficialNativeSessionProvider('claude'), true);
  assert.equal(isOfficialNativeSessionProvider('gemini'), true);
  assert.equal(isOfficialNativeSessionProvider('agy'), true);
  assert.equal(isOfficialNativeSessionProvider('opencode'), true);
  assert.equal(isOfficialNativeSessionProvider('openai'), false);
});

test('opencode native session builds run resume command', () => {
  const resume = buildResumeCommand('opencode', {
    sessionId: 'ses_123',
    prompt: '继续',
    model: 'opencode-go/glm-5.2',
    projectPath: '/repo/project'
  });

  assert.equal(resume.commandName, 'opencode');
  assert.deepEqual(resume.args, [
    'run',
    '--format',
    'json',
    '--dangerously-skip-permissions',
    '--session',
    'ses_123',
    '--model',
    'opencode-go/glm-5.2',
    '--dir',
    '/repo/project',
    '继续'
  ]);
});

test('agy native session builds antigravity CLI start/resume commands', () => {
  // 普通会话走 headless --print：不进 TUI、跳过首次引导、干净输出、正常完成(回复由 transcript 读)。
  // agy 自动生成 conversation id（新会话不预指定）。
  const start = buildStartCommand('agy', { prompt: '你好', model: 'gemini-3-flash', interactiveCli: true });
  assert.equal(start.commandName, 'agy');
  assert.deepEqual(start.args, ['--print', '你好', '--dangerously-skip-permissions', '--model', 'gemini-3-flash']);

  // 恢复：--conversation <id> 续指定会话（同 id 追加，不 fork），本轮同样走 --print。
  const resume = buildResumeCommand('agy', { sessionId: 'conv-123', prompt: '继续', interactiveCli: true });
  assert.equal(resume.commandName, 'agy');
  assert.deepEqual(resume.args, ['--conversation', 'conv-123', '--dangerously-skip-permissions', '--print', '继续']);
});

test('agy native session adopts a new conversation only after the CLI exits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-agy-exit-finalization-'));
  const originalRealHome = process.env.REAL_HOME;
  t.after(() => {
    if (originalRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = originalRealHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.REAL_HOME = root;

  const binDir = path.join(root, 'bin');
  const projectPath = path.join(root, 'project');
  const aiHomeDir = path.join(root, '.ai_home');
  const agyBin = path.join(binDir, 'agy');
  const sessionId = 'agy-created-after-clean-exit';
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '101',
    identitySeed: 'oauth:agy:exit-finalization@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthToken: {
      auth_method: 'consumer',
      token: {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token'
      }
    }
  });
  const runtimeDir = path.join(aiHomeDir, 'run', 'auth-projections', 'agy', accountRef);
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(agyBin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const sessionId = ${JSON.stringify(sessionId)};
const transcript = path.join(
  process.env.AIH_HOST_HOME,
  '.gemini',
  'antigravity-cli',
  'brain',
  sessionId,
  '.system_generated',
  'logs',
  'transcript.jsonl'
);
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.writeFileSync(transcript, [
  JSON.stringify({ type: 'USER_INPUT', created_at: new Date().toISOString(), content: '<USER_REQUEST>hello</USER_REQUEST>' }),
  JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), content: 'AGY_NEW_OK' }),
  ''
].join('\\n'));
process.stdout.write('AGY_NEW_OK\\n');
`, 'utf8');
  fs.chmodSync(agyBin, 0o755);

  const events = [];
  const stream = spawnNativeSessionStream({
    provider: 'agy',
    accountRef,
    projectPath,
    prompt: 'hello',
    interactiveCli: true,
    emitTerminalOutput: false,
    streamRawStdout: true,
    completeOnTranscriptUpdate: false,
    suppressInteractivePrompt: true,
    aiHomeDir,
    env: {
      ...process.env,
      HOME: root,
      AIH_HOST_HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
    },
    getProfileDir: () => runtimeDir,
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0, unresolved: [] }),
    onEvent: (event) => events.push(event)
  });

  const result = await stream.done;

  assert.equal(result.sessionId, sessionId);
  assert.equal(result.content, 'AGY_NEW_OK');
  assert.ok(events.some((event) => event.type === 'session-created' && event.sessionId === sessionId));
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

test('parseNativeStreamEvent tags claude is_error result as terminal (drives post-result kill)', () => {
  // 回归:claude 的错误 result(如 403 鉴权失败)必须标记 claudeTerminalResult,否则
  // native-session 的 kill 分支(只认 type==='result')不触发 → cat<file>- 撑住 stdin →
  // 进程泄漏、onExit 永不触发 → done 永不 settle → webUI 挂到超时。
  const state = { content: '', sessionId: '' };
  const event = parseNativeStreamEvent(
    'claude',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 403,
      result: 'Failed to authenticate. API Error: 403 invalid api-key'
    }),
    state
  );

  assert.equal(event.type, 'error');
  assert.equal(event.claudeTerminalResult, true);
  assert.equal(event.message, 'Failed to authenticate. API Error: 403 invalid api-key');
});

test('parseNativeStreamEvent maps Claude api_retry into canonical retry status', () => {
  const event = parseNativeStreamEvent('claude', JSON.stringify({
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 10,
    retry_delay_ms: 1079.7,
    error_status: 429,
    error: 'rate_limit'
  }), { content: '', sessionId: '' });

  assert.deepEqual(event, {
    type: 'retry-status',
    phase: 'scheduled',
    source: 'upstream-api',
    provider: 'claude',
    attempt: 2,
    maxAttempts: 10,
    retryAfterMs: 1079.7,
    status: 429,
    reason: 'rate_limit'
  });
});

test('parseNativeStreamEvent omits absent Claude retry HTTP status', () => {
  const event = parseNativeStreamEvent('claude', JSON.stringify({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: null,
    error: 'connection_error'
  }), { content: '', sessionId: '' });

  assert.equal(event.status, undefined);
  assert.equal(event.reason, 'connection_error');
});

test('parseNativeStreamEvent leaves claude success result untagged (clean kill, not failure)', () => {
  const state = { content: '', sessionId: '' };
  const event = parseNativeStreamEvent(
    'claude',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '你好，有什么可以帮你的？'
    }),
    state
  );

  assert.equal(event.type, 'result');
  assert.equal(event.claudeTerminalResult, undefined);
  assert.equal(event.content, '你好，有什么可以帮你的？');
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

test('parseNativeStreamEvent parses opencode json run events', () => {
  const state = { content: '', sessionId: '' };
  const created = parseNativeStreamEvent(
    'opencode',
    JSON.stringify({
      type: 'step_start',
      sessionID: 'ses_0ee54c1daffeMaR3jDxVMyeIT7'
    }),
    state
  );
  const delta = parseNativeStreamEvent(
    'opencode',
    JSON.stringify({
      type: 'text',
      sessionID: 'ses_0ee54c1daffeMaR3jDxVMyeIT7',
      part: {
        type: 'text',
        text: 'AIH_OPENCODE_CLI_JSON_OK'
      }
    }),
    state
  );
  const result = parseNativeStreamEvent(
    'opencode',
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_0ee54c1daffeMaR3jDxVMyeIT7',
      part: {
        reason: 'stop'
      }
    }),
    state
  );
  const ignoredResumeStep = parseNativeStreamEvent(
    'opencode',
    JSON.stringify({
      type: 'step_start',
      sessionID: 'ses_0ee54c1daffeMaR3jDxVMyeIT7',
      part: {
        type: 'step-start'
      }
    }),
    state
  );
  const ignoredToolCallsStep = parseNativeStreamEvent(
    'opencode',
    JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_0ee54c1daffeMaR3jDxVMyeIT7',
      part: {
        reason: 'tool-calls'
      }
    }),
    state
  );

  assert.deepEqual(created, {
    type: 'session-created',
    sessionId: 'ses_0ee54c1daffeMaR3jDxVMyeIT7'
  });
  assert.deepEqual(delta, {
    type: 'delta',
    delta: 'AIH_OPENCODE_CLI_JSON_OK'
  });
  assert.deepEqual(result, {
    type: 'result',
    content: 'AIH_OPENCODE_CLI_JSON_OK'
  });
  assert.deepEqual(ignoredResumeStep, {
    type: 'ignored'
  });
  assert.deepEqual(ignoredToolCallsStep, {
    type: 'ignored'
  });
  assert.equal(state.sessionId, 'ses_0ee54c1daffeMaR3jDxVMyeIT7');
  assert.equal(state.content, 'AIH_OPENCODE_CLI_JSON_OK');
});

test('parseNativeStreamEvent maps OpenCode retry parts without guessing missing timing', () => {
  const event = parseNativeStreamEvent('opencode', JSON.stringify({
    type: 'retry',
    sessionID: 'ses_retry',
    part: {
      type: 'retry',
      attempt: 3,
      error: { name: 'ProviderOverloadedError', message: 'provider overloaded', statusCode: 503 }
    }
  }), { content: '', sessionId: '' });

  assert.deepEqual(event, {
    type: 'retry-status',
    phase: 'scheduled',
    source: 'provider-runtime',
    provider: 'opencode',
    attempt: 3,
    status: 503,
    reason: 'ProviderOverloadedError',
    message: 'provider overloaded'
  });
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
