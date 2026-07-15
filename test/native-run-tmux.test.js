const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  RUN_EXIT_MARKER,
  socketForRun,
  buildRunShellCommand,
  buildInnerCommandFromArgv
} = require('../lib/server/native-run-tmux');
const {
  writeRunManifest,
  readRunManifest,
  updateRunManifest,
  removeRunManifest,
  listRunManifests,
  runLogPath
} = require('../lib/server/native-run-manifest');
const { createNativeRunLogTail } = require('../lib/server/native-run-log-tail');
const { adoptWebUiNativeRuns } = require('../lib/server/native-run-adoption');

// tmux 化 native run 的基础件：manifest 落盘/命令组装/日志 tail/启动收养。

test('manifest 写读改删 + runId 安全校验', (t) => {
  const aiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-run-manifest-'));
  t.after(() => fs.rmSync(aiHome, { recursive: true, force: true }));

  const entry = writeRunManifest(aiHome, {
    runId: 'run-abc-123', provider: 'opencode', gateway: true,
    socket: 'aih-run-runabc123', logPath: runLogPath(aiHome, 'run-abc-123'),
    projectPath: '/tmp/p', startedAt: 111
  });
  assert.ok(entry);
  assert.equal(readRunManifest(aiHome, 'run-abc-123').provider, 'opencode');
  assert.equal(readRunManifest(aiHome, 'run-abc-123').gateway, true);
  assert.equal(Object.prototype.hasOwnProperty.call(readRunManifest(aiHome, 'run-abc-123'), 'accountRef'), false);

  updateRunManifest(aiHome, 'run-abc-123', { sessionId: 'ses_x' });
  assert.equal(readRunManifest(aiHome, 'run-abc-123').sessionId, 'ses_x');
  assert.equal(listRunManifests(aiHome).length, 1);

  // 不安全 runId(路径穿越)拒绝
  assert.equal(writeRunManifest(aiHome, { runId: '../evil', provider: 'x', socket: 's', logPath: '/tmp/l' }), null);

  removeRunManifest(aiHome, 'run-abc-123');
  assert.equal(readRunManifest(aiHome, 'run-abc-123'), null);
});

test('shell 命令组装:整体重定向 + 退出标记 + 参数安全引用', () => {
  const inner = buildInnerCommandFromArgv('/usr/bin/claude', ['--print', "it's"]);
  assert.match(inner, /'\/usr\/bin\/claude' '--print' 'it'\\''s'/);
  const wrapped = buildRunShellCommand('cat a - | claude', '/tmp/run.log');
  assert.match(wrapped, /^\{ cat a - \| claude ; \} > '\/tmp\/run\.log' 2>&1;/);
  assert.ok(wrapped.includes(RUN_EXIT_MARKER));
  assert.match(socketForRun('a3bd024a-0074-421c'), /^aih-run-[A-Za-z0-9]{1,12}$/);
});

test('日志 tail:增量行 + flush 吸干尾部无换行内容', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-run-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'run.log');
  const lines = [];
  const tail = createNativeRunLogTail(logPath, { intervalMs: 50, onLine: (l) => lines.push(l) });
  t.after(() => tail.stop());

  fs.writeFileSync(logPath, '{"a":1}\n{"b":');
  await new Promise((r) => setTimeout(r, 140));
  assert.deepEqual(lines, ['{"a":1}']);
  fs.appendFileSync(logPath, '2}\n');
  await new Promise((r) => setTimeout(r, 140));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  fs.appendFileSync(logPath, 'tail-no-newline');
  tail.flush();
  assert.equal(lines[2], 'tail-no-newline');
});

test('收养:死 run 直接收尾,活 run 注册并在退出标记后统一收尾', async (t) => {
  const aiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-run-adopt-'));
  t.after(() => fs.rmSync(aiHome, { recursive: true, force: true }));

  // 死 run:日志带退出标记
  const deadLog = runLogPath(aiHome, 'dead-run-1');
  fs.mkdirSync(path.dirname(deadLog), { recursive: true });
  fs.writeFileSync(deadLog, `{"type":"result"}\n${RUN_EXIT_MARKER}0\n`);
  writeRunManifest(aiHome, { runId: 'dead-run-1', provider: 'opencode', accountRef: 'acct_11111111111111111111', socket: 'aih-run-dead', logPath: deadLog, sessionId: 'ses_dead' });

  // 活 run:tmux has-session 用假 spawnSync 模拟「活着」,随后写退出标记模拟跑完
  const liveLog = runLogPath(aiHome, 'live-run-2');
  fs.writeFileSync(liveLog, '{"type":"thread.started","thread_id":"ses_live"}\n');
  writeRunManifest(aiHome, { runId: 'live-run-2', provider: 'codex', accountRef: 'acct_22222222222222222222', socket: 'aih-run-live', logPath: liveLog });

  const registered = [];
  const unregistered = [];
  const finished = [];
  let liveAlive = true;
  const fakeSpawnSync = (cmd, args) => {
    if (cmd === 'tmux' && args.includes('has-session')) {
      const socketName = args[args.indexOf('-L') + 1];
      if (socketName === 'aih-run-dead') return { status: 1 };
      return { status: liveAlive ? 0 : 1 };
    }
    return { status: 0 };
  };

  const result = adoptWebUiNativeRuns({
    aiHomeDir: aiHome,
    spawnSyncImpl: fakeSpawnSync,
    registerNativeChatRun: (h) => registered.push(h),
    unregisterNativeChatRun: (id) => unregistered.push(id),
    onRunFinished: (manifest, info) => finished.push({ runId: manifest.runId, sessionId: manifest.sessionId, ...info })
  });

  assert.equal(result.finalized, 1);
  assert.equal(result.adopted, 1);
  // 死 run:立即收尾 + 清单删除
  assert.ok(finished.some((f) => f.runId === 'dead-run-1' && f.exitCode === 0 && f.adopted === false));
  assert.equal(readRunManifest(aiHome, 'dead-run-1'), null);
  // 活 run:已注册,sessionId 从日志重放回填
  assert.equal(registered.length, 1);
  assert.equal(registered[0].runId, 'live-run-2');
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(registered[0].sessionId, 'ses_live');

  // 模拟跑完:写退出标记 → 收尾 + 注销 + 清单删除
  fs.appendFileSync(liveLog, `${RUN_EXIT_MARKER}0\n`);
  await new Promise((r) => setTimeout(r, 320));
  assert.ok(unregistered.includes('live-run-2'));
  assert.ok(finished.some((f) => f.runId === 'live-run-2' && f.adopted === true && f.sessionId === 'ses_live'));
  assert.equal(readRunManifest(aiHome, 'live-run-2'), null);
});
