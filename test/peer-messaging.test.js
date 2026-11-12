'use strict';

// aih peer：目标解析、通道分派、注入命令的形状。
// 协议本身（claude UDS）的守卫在 test/claude-peer.test.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const persistentSession = require('../lib/runtime/persistent-session');
const { createTmuxSessionAdapter } = require('../lib/cli/services/peer/adapters/tmux-session');
const {
  findPeerTarget,
  listPeerTargets,
  sendPeerMessage,
  replyToMessage,
  listInbox,
  flushPending,
  formatPeerTarget
} = require('../lib/cli/services/peer');
const { createPeerStore, shortMessageId } = require('../lib/cli/services/peer/store');
const { formatPeerEnvelope, collapseBody } = require('../lib/cli/services/peer/envelope');
const { isQuiet, waitForQuiet } = require('../lib/cli/services/peer/idle');
const { parseArgs, runPeerCommand } = require('../lib/cli/commands/peer-router');

const SCOPE = 'acct_9dc03880a872f711983e';

function tempAiHome(prefix = 'aih-peer-test-') {
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix));
}

async function withTempAiHome(run) {
  const aiHomeDir = tempAiHome();
  try {
    return await run(aiHomeDir);
  } finally {
    nodeFs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
}

const ROW = {
  cliName: 'codebuddycn',
  runtimeScope: SCOPE,
  targetSession: 'p-aih-1a2b',
  name: 'p-aih-1a2b',
  path: '/Users/model/projects/feature/ai_home',
  agentSessionId: 'sess-1',
  live: true,
  completed: false,
  // 扫描时的活动快照。注意：它只能说明「扫描那一刻之前有没有输出」，投递前仍然
  // 必须现场探测 tmux，不能用它判「已经安静」。
  lastActivityAt: Date.now() - 60_000
};

function fakeSessionAdapter(rows, sent) {
  return createTmuxSessionAdapter({
    collectRows: () => ({ rows }),
    resolveCommandPath: () => '/opt/homebrew/bin/tmux',
    fs: { existsSync: () => true },
    spawnSync: (command, args) => {
      // 只记真正打字的命令：投递前的活动探测也是 spawnSync，混进来会把「发了几条」算错。
      if (args.includes('send-keys')) sent.push([command, ...args].join(' '));
      return { status: 0 };
    }
  });
}

test('buildSendKeysCommands：正文按字面量写，Enter 单独一条', () => {
  const commands = persistentSession.buildSendKeysCommands({
    cliName: 'codebuddycn',
    runtimeScope: SCOPE,
    sessionName: 'p-aih-1a2b',
    text: '你好 "quoted" $HOME'
  });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].args.slice(-3), ['-l', '--', '你好 "quoted" $HOME']);
  assert.equal(commands[1].args.at(-1), 'Enter');
  // 同一条 send-keys 里塞 Enter 会被当字面量打出来——这条守卫防的就是回退成那种写法。
  assert.equal(commands[0].args.includes('Enter'), false);
});

test('buildSendKeysCommands：不安全的会话名一律拒绝，appendNewline=false 只发正文', () => {
  assert.deepEqual(persistentSession.buildSendKeysCommands({
    cliName: 'codex',
    runtimeScope: SCOPE,
    sessionName: '../evil',
    text: 'x'
  }), []);
  const single = persistentSession.buildSendKeysCommands({
    cliName: 'codex',
    runtimeScope: SCOPE,
    sessionName: 'p-ok',
    text: 'x',
    appendNewline: false
  });
  assert.equal(single.length, 1);
});

test('findPeerTarget：id / 名字 / 原生会话 id / 唯一前缀；多义不猜', () => {
  const targets = [
    { id: 'claude:11', name: 'alpha', sessionId: 'sid-a', channel: 'native' },
    { id: 'session:codex:acct_1:p-1', name: 'p-one', sessionId: 'sid-b', channel: 'inject' },
    { id: 'session:codex:acct_1:p-2', name: 'p-two', sessionId: 'sid-c', channel: 'inject' }
  ];
  assert.equal(findPeerTarget(targets, 'claude:11').target.name, 'alpha');
  assert.equal(findPeerTarget(targets, 'p-one').target.id, 'session:codex:acct_1:p-1');
  assert.equal(findPeerTarget(targets, 'sid-c').target.name, 'p-two');
  assert.equal(findPeerTarget(targets, 'p-').ambiguous.length, 2);
  assert.equal(findPeerTarget(targets, 'nope').target, null);
});

test('listPeerTargets：native 与 inject 合并，--channel / --provider 都能收窄', async () => {
  const adapter = fakeSessionAdapter([ROW], []);
  const nativePeers = [{ pid: 11, name: 'alpha', socket: '/tmp/x.sock', status: 'idle' }];
  const base = {
    createTmuxSessionAdapter: () => adapter,
    listNativePeers: () => nativePeers
  };
  const all = await listPeerTargets({ ...base, env: {} });
  assert.deepEqual(all.targets.map((row) => row.channel).sort(), ['inject', 'native']);

  const injectOnly = await listPeerTargets({ ...base, env: {}, channel: 'inject' });
  assert.deepEqual(injectOnly.targets.map((row) => row.id), [`session:codebuddycn:${SCOPE}:p-aih-1a2b`]);

  const provider = await listPeerTargets({ ...base, env: {}, provider: 'claude' });
  assert.deepEqual(provider.targets.map((row) => row.name), ['alpha']);
});

test('sendPeerMessage(inject)：正文打进目标 pane，并回报通道', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const sent = [];
    const adapter = fakeSessionAdapter([ROW], sent);
    const result = await sendPeerMessage(
      { target: 'p-aih-1a2b', text: '继续跑' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [] }
    );
    assert.equal(result.ok, true);
    assert.equal(result.state, 'delivered');
    assert.equal(result.channel, 'inject');
    assert.match(result.shortId, /^pm-/);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /send-keys -t p-aih-1a2b -l -- \[aih-peer #pm-[0-9a-f]+ from aih-cli .*\] 继续跑$/);
    assert.match(sent[1], /send-keys -t p-aih-1a2b Enter$/);
  });
});

test('sendPeerMessage(inject)：dry-run 只给命令，不碰 tmux', async () => {
  const sent = [];
  const adapter = fakeSessionAdapter([ROW], sent);
  const result = await sendPeerMessage(
    { target: 'p-aih-1a2b', text: 'hi', dryRun: true },
    { env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [] }
  );
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(sent.length, 0);
  assert.equal(result.commands.length, 2);
});

test('sendPeerMessage(native)：走 claude 协议，带 mode/from，回报两个 id', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const calls = [];
    const result = await sendPeerMessage(
      { target: 'alpha', text: 'hello', mode: 'bypass', fromAddress: 'uds:%2Ftmp%2F1.sock' },
      {
        aiHomeDir,
        env: {},
        createTmuxSessionAdapter: () => fakeSessionAdapter([], []),
        listNativePeers: () => [{ pid: process.pid, name: 'alpha', socket: '/tmp/x.sock', status: 'idle' }],
        sendNative: (peer, text, options) => {
          calls.push({ peer, text, options });
          return Promise.resolve({ ok: true, msgId: 'cc-msg-1' });
        }
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'native');
    // 我们自己的 msg-id 是收件箱里的那条；对端的 msg_id 单独记。
    assert.match(result.messageId, /^pm-[0-9a-f]{32}$/);
    assert.equal(result.channelMessageId, 'cc-msg-1');
    assert.equal(calls[0].options.mode, 'bypass');
    assert.equal(calls[0].options.fromAddress, 'uds:%2Ftmp%2F1.sock');
    assert.match(calls[0].text, /^\[aih-peer #pm-[0-9a-f]+ from uds:%2Ftmp%2F1\.sock .*\] hello$/);
  });
});

test('sendPeerMessage：目标不存在时给可执行的提示，不是空结果', async () => {
  const result = await sendPeerMessage(
    { target: 'ghost', text: 'hi' },
    { env: {}, createTmuxSessionAdapter: () => fakeSessionAdapter([], []), listNativePeers: () => [] }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'target_not_found');
  assert.match(result.message, /aih peer list/);
});

test('aih peer：参数解析把正文里的旗标当正文，不当选项', () => {
  const parsed = parseArgs(['send', 'p-1', '看下', '--dry-run']);
  assert.equal(parsed.action, 'send');
  assert.equal(parsed.target, 'p-1');
  assert.deepEqual(parsed.text, ['看下']);
  assert.equal(parsed.dryRun, true);

  const withFlags = parseArgs(['send', 'alpha', 'hi', '--mode', 'bypass', '--from', 'uds:x', '--channel', 'native']);
  assert.equal(withFlags.mode, 'bypass');
  assert.equal(withFlags.fromAddress, 'uds:x');
  assert.equal(withFlags.channel, 'native');
  assert.deepEqual(withFlags.text, ['hi']);
});

test('aih peer list --json：输出机器可读的目标列表', async () => {
  const chunks = [];
  const fakeService = {
    normalizeChannel: (value) => (value === 'inject' || value === 'native' ? value : ''),
    formatPeerTarget: () => 'row',
    listPeerCapabilities: () => [],
    listInbox: () => [],
    resolveSelfIdentity: () => null,
    listPeerTargets: async () => ({
      channels: ['native', 'inject'],
      targets: [{
        id: 'session:codex:acct_1:p-1', provider: 'codex', channel: 'inject', name: 'p-1',
        sessionId: 'sid-1', cwd: '/tmp', status: 'idle'
      }]
    }),
    sendPeerMessage: async () => ({ ok: false, error: 'unused' })
  };
  const code = await runPeerCommand(['list', '--json'], {
    peerService: fakeService,
    aiHomeDir: '/tmp/aih',
    env: {},
    stdout: { write: (text) => chunks.push(text) },
    stderr: { write: () => {} }
  });
  assert.equal(code, 0);
  const payload = JSON.parse(chunks.join(''));
  assert.equal(payload.targets[0].id, 'session:codex:acct_1:p-1');
  assert.equal(payload.targets[0].channel, 'inject');
});

test('aih peer send：缺正文时报用法而不是静默成功', async () => {
  const errs = [];
  const code = await runPeerCommand(['send', 'p-1'], {
    peerService: { normalizeChannel: () => '', listPeerTargets: async () => ({ targets: [] }), sendPeerMessage: async () => ({ ok: true }), formatPeerTarget: () => '' },
    aiHomeDir: '/tmp/aih',
    env: {},
    stdout: { write: () => {} },
    stderr: { write: (text) => errs.push(text) }
  });
  assert.equal(code, 1);
  assert.match(errs.join(''), /缺少正文/);
});

test('formatPeerTarget：provider / 通道 / 状态 / 名字 一列对齐', () => {
  const line = formatPeerTarget({
    provider: 'claude', channel: 'native', status: 'idle', name: 'alpha', cwd: '/tmp'
  });
  assert.match(line, /^claude\s+native\s+idle/);
});
// --- 通道覆盖：每个能跑持久会话的 harness 都必须在表里，且必须能发 -----------------

test('harness 通道表覆盖 listSupportedAiClis 的全部 provider（新增 provider 会被这条挡住）', () => {
  const { listSupportedAiClis } = require('../lib/cli/services/ai-cli/provider-registry');
  const { HARNESS_CHANNELS, getHarnessChannel } = require('../lib/cli/services/peer/adapters/registry');
  const declared = new Set(HARNESS_CHANNELS.map((entry) => entry.provider));
  const missing = listSupportedAiClis().filter((provider) => !declared.has(provider));
  assert.deepEqual(missing, [], `这些 provider 还没有 peer 通道实现：${missing.join(', ')}`);
  for (const provider of listSupportedAiClis()) {
    const entry = getHarnessChannel(provider);
    assert.ok(entry, provider);
    assert.ok(['native', 'inject'].includes(entry.channel), `${provider} 的 channel 非法`);
    assert.ok(entry.label && entry.note && entry.adapter, `${provider} 缺 label/note/adapter`);
  }
});

test('native 通道的 provider 必须真的能解析出实现（不能只写表）', () => {
  const { HARNESS_CHANNELS, getNativeAdapter } = require('../lib/cli/services/peer/adapters/registry');
  for (const entry of HARNESS_CHANNELS.filter((row) => row.channel === 'native')) {
    const adapter = getNativeAdapter(entry.provider);
    assert.ok(adapter, `${entry.provider} 声明了 native 却没有实现`);
    assert.equal(typeof adapter.listPeers, 'function');
    assert.equal(typeof adapter.sendToPeer, 'function');
  }
  assert.equal(getNativeAdapter('codex'), null);
});

test('会话目标的 harness 标注来自同一张表', async () => {
  const adapter = fakeSessionAdapter([ROW], []);
  const listing = await listPeerTargets({
    env: {},
    createTmuxSessionAdapter: () => adapter,
    listNativePeers: () => []
  });
  const target = listing.targets[0];
  assert.equal(target.harness.label, 'CodeBuddy CN');
  assert.match(target.harness.note, /注入/);
});

test('aih peer channels --json：能力表可机器读', async () => {
  const chunks = [];
  const code = await runPeerCommand(['channels', '--json'], {
    aiHomeDir: '/tmp/aih',
    env: {},
    stdout: { write: (text) => chunks.push(text) },
    stderr: { write: () => {} }
  });
  assert.equal(code, 0);
  const payload = JSON.parse(chunks.join(''));
  assert.ok(payload.channels.length >= 14);
  assert.ok(payload.channels.some((row) => row.provider === 'claude' && row.channel === 'native'));
  assert.ok(payload.channels.some((row) => row.provider === 'codebuddycn' && row.channel === 'inject'));
});

// --- 补全的边界：注册表只记「起过」的会话，缓存里更新 ---------------------------

test('补全：缓存里有、注册表里没有的会话也要出现（刚起的会话）', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { listPersistentSessionNames } = require('../lib/cli/complete/persistent-candidates');
  const registry = require('../lib/runtime/persistent-session-registry');
  const cache = require('../lib/runtime/persistent-session-cache');

  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-peer-complete-'));
  try {
    const accountRef = 'acct_0123456789abcdef0123';
    registry.writeEntry(aiHomeDir, {
      provider: 'codex',
      accountRef,
      runtimeScope: accountRef,
      socket: 'aih-codex-acct_0123456789abcdef0123',
      session: 'p-registered',
      cwd: '/tmp/proj',
      label: 'proj'
    }, { strict: true });
    cache.write(aiHomeDir, [{
      name: 'p-cached-only',
      cliName: 'codebuddycn',
      path: '/tmp/proj',
      description: '刚起的会话',
      live: true
    }]);

    const rows = listPersistentSessionNames({ aiHomeDir, cwd: '/tmp/proj', env: {} });
    const names = rows.map((row) => row.name);
    assert.ok(names.includes('p-registered'), '注册表里的会话不能丢');
    assert.ok(names.includes('p-cached-only'), '缓存里有、注册表没有的会话必须补上');
    const cachedRow = rows.find((row) => row.name === 'p-cached-only');
    assert.equal(cachedRow.provider, 'codebuddycn');
    assert.equal(cachedRow.live, true);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
// --- 投影 HOME：在会话里（shell drawer / harness 自己）也要看到宿主会话 -------------

test('host-home：投影 HOME 换回宿主家目录，非投影保持原样', () => {
  const os = require('node:os');
  const { looksProjectedHome, resolveUnprojectedHostHomeDir } = require('../lib/runtime/host-home');
  const real = os.userInfo().homedir;
  const fakeOs = { userInfo: () => ({ homedir: real }), homedir: () => real };

  assert.equal(looksProjectedHome('/x/.ai_home/run/auth-projections/codebuddycn/acct_a'), true);
  assert.equal(looksProjectedHome('/x/.ai_home/run/login/claude'), true);
  assert.equal(looksProjectedHome('/Users/model'), false);

  assert.equal(
    resolveUnprojectedHostHomeDir({
      env: { HOME: '/x/.ai_home/run/auth-projections/codebuddycn/acct_a' },
      os: fakeOs
    }),
    real,
    '投影 HOME 必须回到 passwd 家目录，否则会话列表一条都看不到'
  );
  assert.equal(resolveUnprojectedHostHomeDir({ env: { HOME: '/tmp/plain' }, os: fakeOs }), '/tmp/plain');
  assert.equal(
    resolveUnprojectedHostHomeDir({ env: { HOME: '/tmp/plain', AIH_HOST_HOME: '/host' }, os: fakeOs }),
    '/host'
  );
});

test('aih ss：投影里注入的 aiHomeDir 会被换成宿主那份，普通路径不动', () => {
  const os = require('node:os');
  const { resolveListableAiHomeDir } = require('../lib/cli/services/ai-cli/persistent-session-list');
  const real = os.userInfo().homedir;
  const projected = '/x/.ai_home/run/auth-projections/codebuddycn/acct_a/.ai_home';

  assert.equal(
    resolveListableAiHomeDir(projected, { env: { HOME: '/x/.ai_home/run/auth-projections/codebuddycn/acct_a' } }),
    real + '/.ai_home'
  );
  assert.equal(resolveListableAiHomeDir('/tmp/aih-test', { env: {} }), '/tmp/aih-test');
});

// --- 收件箱：落盘 / 抢锁 / 归档 / 前缀查找 ---------------------------------------

test('store：消息落盘后只有一次 claim 能抢到，归档后状态跟着目录走', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const record = store.createMessage({
      from: { channel: 'inject', name: 'p-src' },
      to: { channel: 'inject', name: 'p-dst', delivery: { cliName: 'codex', runtimeScope: SCOPE, sessionName: 'p-dst' } },
      body: 'hello'
    });
    assert.match(record.id, /^pm-[0-9a-f]{32}$/);
    assert.equal(record.state, 'pending');

    const first = store.claim(record.id);
    const second = store.claim(record.id);
    assert.ok(first.record, '第一次抢锁必须成功');
    assert.equal(second.record, null, '第二次抢锁必须失败（rename 原子）');

    const settled = store.settleDelivered(first.record, { channelMessageId: 'cc-1' });
    assert.equal(settled.state, 'delivered');
    assert.equal(store.listMessages({ state: 'pending' }).length, 0);
    const delivered = store.listMessages({ state: 'delivered' });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].channelMessageId, 'cc-1');
    // 已送达但没读 = 收件箱里「待处理」
    assert.equal(store.listMessages({ state: 'open' }).length, 1);
    assert.equal(store.listMessages({ state: 'unread' }).length, 1);
    store.markRead(record.id);
    assert.equal(store.listMessages({ state: 'unread' }).length, 0);
    assert.equal(store.listMessages({ state: 'read' }).length, 1);
  });
});

test('store：短前缀能定位，太短的前缀直接拒绝（不替用户猜）', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const record = store.createMessage({ from: { name: 'a' }, to: { name: 'b' }, body: 'x' });
    assert.equal(store.findMessage(shortMessageId(record.id)).record.id, record.id);
    assert.equal(store.findMessage(record.id).record.id, record.id);
    assert.equal(store.findMessage('pm-').tooShort, true);
    assert.equal(store.findMessage('pm-zzzzzz').record, null);
  });
});

test('store：超时未投出的消息转 failed，不会永远占着收件箱', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const past = Date.now() - 60_000;
    const oldStore = createPeerStore({ aiHomeDir, now: () => past });
    oldStore.createMessage({ from: { name: 'a' }, to: { name: 'b' }, body: 'x' });

    const store = createPeerStore({ aiHomeDir });
    assert.equal(store.expireStale(30_000), 1);
    assert.equal(store.listMessages({ state: 'pending' }).length, 0);
    assert.equal(store.listMessages({ state: 'failed' }).length, 1);
  });
});

test('store：崩溃留下的 inflight 孤儿会被退回 pending', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir, inflightStaleMs: 1 });
    const record = store.createMessage({ from: { name: 'a' }, to: { name: 'b' }, body: 'x' });
    assert.ok(store.claim(record.id).record);
    const future = createPeerStore({ aiHomeDir, inflightStaleMs: 1, now: () => Date.now() + 10_000 });
    assert.equal(future.recoverStaleInflight(), 1);
    assert.equal(future.listMessages({ state: 'pending' }).length, 1);
  });
});

test('store：attempts 明细只留最近 N 条，attemptCount 继续累加', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir, maxAttemptLog: 3 });
    const record = store.createMessage({ from: { name: 'a' }, to: { name: 'b' }, body: 'x' });
    let current = record;
    for (let i = 1; i <= 5; i += 1) {
      const claimed = store.claim(current.id);
      current = store.settlePending(claimed.record || current, `fail-${i}`, { retryAfterMs: 0 });
    }
    assert.equal(current.attempts.length, 3, '明细只留最近 3 条');
    assert.equal(current.attemptCount, 5, '总次数照常累加');
    assert.deepEqual(current.attempts.map((item) => item.error), ['fail-3', 'fail-4', 'fail-5']);
    // 落盘的记录也得是这个形状（不能只有内存里对）。
    const reread = store.listMessages({ state: 'pending' })[0];
    assert.equal(reread.attempts.length, 3);
    assert.equal(reread.attemptCount, 5);
  });
});

test('flushPending：明细被截断后，退避按总次数走，不会退回 3s', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    // 故意把上限压到 2：默认的 20 条乘以指数退避早就撞上 60s 封顶，测不出「读数组长度」
    // 这个错误——只有明细很短时才看得出退避有没有被重置。
    const store = createPeerStore({ aiHomeDir, maxAttemptLog: 2 });
    const record = store.createMessage({
      from: { name: 'p-src' },
      to: {
        channel: 'inject', name: 'p-busy', address: 'p-busy',
        delivery: { cliName: 'codebuddycn', runtimeScope: SCOPE, sessionName: 'p-busy' }
      },
      body: '一直忙'
    });
    // 造一条「已经试了 50 次、明细只剩 2 条」的老消息（截断上线前攒下的那种）。
    store.settlePending(
      {
        ...record,
        attemptCount: 50,
        attempts: new Array(2).fill({ at: 0, channel: 'inject', ok: false, error: 'target_busy' })
      },
      'target_busy',
      { retryAfterMs: 0 }
    );

    const summary = await flushPending({
      aiHomeDir,
      store,
      sessionAdapter: { send: () => ({ ok: false, error: 'target_busy' }) },
      timeoutMs: 0,
      env: {}
    });
    assert.equal(summary.pending, 1);
    const pending = store.listMessages({ state: 'pending' })[0];
    assert.equal(pending.attempts.length, 2, '明细保持上限');
    assert.equal(pending.attemptCount, 52, '51 次历史 + 这一轮');
    const wait = pending.nextAttemptAt - Date.now();
    assert.ok(wait > 55_000, `退避应该按 52 次算到 60s 封顶，实际 ${wait}ms`);
  });
});

// --- 信封：单行、可回复、超长截断 -----------------------------------------------

test('envelope：压成单行并带上 msg-id 与回复命令', () => {
  const text = formatPeerEnvelope({
    id: 'pm-abcdef12',
    from: { name: 'p-src' },
    body: '第一行\n第二行\r\n第三行'
  });
  assert.equal(text.includes('\n'), false, '真实换行会被 TUI 当成提前提交');
  assert.match(text, /^\[aih-peer #pm-abcdef12 from p-src \| reply: aih peer reply pm-abcdef12\] /);
  assert.match(text, /第一行\\n第二行\\n第三行$/);
});

test('envelope：超长正文截断并指向 aih peer read', () => {
  const text = collapseBody('x'.repeat(5000), { maxBodyChars: 100, id: 'pm-abcdef12' });
  assert.ok(text.length <= 100);
  assert.match(text, /完整内容: aih peer read pm-abcdef12/);
});

test('envelope：控制字符被清掉（避免触发终端快捷键）', () => {
  const text = collapseBody('a\u0003b\u0007c');
  assert.equal(text, 'abc');
});

// --- 空闲判定 -------------------------------------------------------------------

function createFakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    sleep: async (ms) => { current += ms; }
  };
}

test('idle：0 表示未知（按可投），新旧活动时间决定忙闲', () => {
  assert.equal(isQuiet(0, { now: 10_000 }), true);
  assert.equal(isQuiet(8_500, { now: 10_000, quietMs: 1_200 }), true);
  assert.equal(isQuiet(9_900, { now: 10_000, quietMs: 1_200 }), false);
});

test('idle：等不到安静期就按超时返回，不在循环里空转', async () => {
  const clock = createFakeClock();
  const alwaysBusy = await waitForQuiet({
    quietMs: 500,
    timeoutMs: 3_000,
    pollMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
    readActivityAt: async () => clock.now()
  });
  assert.equal(alwaysBusy.quiet, false);
  assert.equal(alwaysBusy.waitedMs, 3_000);

  const quietClock = createFakeClock();
  const quiet = await waitForQuiet({
    quietMs: 500,
    timeoutMs: 3_000,
    now: quietClock.now,
    sleep: quietClock.sleep,
    readActivityAt: async () => quietClock.now() - 10_000
  });
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.waitedMs, 0);
});

// --- 忙则入队 / 空闲后补投 -------------------------------------------------------

function busyRow(overrides = {}) {
  return { ...ROW, lastActivityAt: Date.now(), ...overrides };
}

test('注入通道忙时：消息留在 pending，并记下退避时刻', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const sent = [];
    const adapter = createTmuxSessionAdapter({
      collectRows: () => ({ rows: [busyRow()] }),
      resolveCommandPath: () => '/opt/homebrew/bin/tmux',
      fs: { existsSync: () => true },
      spawnSync: (command, args) => {
        if (args.includes('send-keys')) sent.push(args.join(' '));
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000)) };
      }
    });
    const result = await sendPeerMessage(
      { target: 'p-aih-1a2b', text: '忙时发' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [], timeoutMs: 100 }
    );
    assert.equal(result.ok, true, '消息已经落盘，发送就算成功');
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'target_busy');
    assert.equal(sent.length, 0, '忙的时候一个字都不能打进 pane');
    const pending = createPeerStore({ aiHomeDir }).listMessages({ state: 'pending' });
    assert.equal(pending.length, 1);
    assert.ok(pending[0].nextAttemptAt > Date.now());
  });
});

test('注入通道：列表快照看着安静、现场仍在输出时，必须判忙而不是硬塞', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const sent = [];
    const adapter = createTmuxSessionAdapter({
      // 快照说「6 秒没输出」= 看起来安静，但现场探测每次都返回当前秒 = 一直在输出。
      collectRows: () => ({ rows: [busyRow({ lastActivityAt: Date.now() - 6_000 })] }),
      resolveCommandPath: () => '/opt/homebrew/bin/tmux',
      fs: { existsSync: () => true },
      spawnSync: (command, args) => {
        if (args.includes('send-keys')) sent.push(args.join(' '));
        return { status: 0, stdout: String(Math.floor(Date.now() / 1000)) };
      }
    });
    const result = await sendPeerMessage(
      { target: 'p-aih-1a2b', text: '别打进忙碌的 pane' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [], timeoutMs: 100 }
    );
    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'target_busy');
    assert.equal(sent.length, 0, '快照过时不能当作「已经安静」');
  });
});

test('flushPending：退避未到点的消息不重复尝试，到点后补投成功', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const sent = [];
    const adapter = fakeSessionAdapter([ROW], sent);
    const busyAdapter = createTmuxSessionAdapter({
      collectRows: () => ({ rows: [busyRow()] }),
      resolveCommandPath: () => '/opt/homebrew/bin/tmux',
      fs: { existsSync: () => true },
      spawnSync: () => ({ status: 0, stdout: String(Math.floor(Date.now() / 1000)) })
    });
    await sendPeerMessage(
      { target: 'p-aih-1a2b', text: '等会再投' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => busyAdapter, listNativePeers: () => [], timeoutMs: 100 }
    );

    const early = await flushPending({
      aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, timeoutMs: 0
    });
    assert.equal(early.attempted, 0, '退避没到点就不该再试');

    const late = await flushPending({
      aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, timeoutMs: 0,
      now: () => Date.now() + 10_000
    });
    assert.equal(late.delivered, 1);
    assert.equal(sent.filter((line) => line.includes('send-keys')).length, 2);
  });
});

// --- 回复 -----------------------------------------------------------------------

test('replyToMessage：解析原发送方、带上 replyTo，并把原消息标记已读', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const srcRow = { ...ROW, targetSession: 'p-src', name: 'p-src', agentSessionId: 'sess-src' };
    const dstRow = { ...ROW, targetSession: 'p-dst', name: 'p-dst', agentSessionId: 'sess-dst' };
    const sent = [];
    const adapter = fakeSessionAdapter([srcRow, dstRow], sent);
    const store = createPeerStore({ aiHomeDir });
    const original = store.createMessage({
      from: { channel: 'inject', provider: 'codebuddycn', name: 'p-src', address: 'p-src', sessionId: 'sess-src' },
      to: { channel: 'inject', provider: 'codebuddycn', name: 'p-dst', address: 'p-dst', sessionId: 'sess-dst' },
      body: '在吗'
    });
    store.claim(original.id);
    store.settleDelivered(original, {});

    const result = await replyToMessage(
      { messageId: shortMessageId(original.id), text: '在' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [] }
    );
    assert.equal(result.ok, true);
    assert.equal(result.state, 'delivered');
    assert.equal(result.replyTo, original.id);
    assert.match(sent[0], /-t p-src -l -- \[aih-peer #pm-[0-9a-f]+ from aih-cli/);
    assert.match(sent[0], /\] 在$/);

    const after = store.findMessage(original.id).record;
    assert.equal(after.state, 'read');
  });
});

test('replyToMessage：sessionId 多义时退回名字定位（codebuddy 的 pane 会共享 agentSessionId）', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    // 实测：未绑定原生会话的 pane 会共用同一个 agentSessionId，只按 id 找必然多义。
    const shared = 'shared-agent-session-id';
    const srcRow = { ...ROW, targetSession: 'p-src', name: 'p-src', agentSessionId: shared };
    const otherRow = { ...ROW, targetSession: 'p-other', name: 'p-other', agentSessionId: shared };
    const sent = [];
    const adapter = fakeSessionAdapter([srcRow, otherRow], sent);
    const store = createPeerStore({ aiHomeDir });
    const original = store.createMessage({
      from: { channel: 'inject', provider: 'codebuddycn', name: 'p-src', address: 'p-src', sessionId: shared },
      to: { channel: 'inject', provider: 'codebuddycn', name: 'p-dst', address: 'p-dst' },
      body: '在吗'
    });

    const result = await replyToMessage(
      { messageId: original.id, text: '在' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => adapter, listNativePeers: () => [] }
    );
    assert.equal(result.ok, true, 'sessionId 多义不能直接判成 sender_not_found');
    assert.match(sent[0], /-t p-src -l -- /);
    assert.equal(sent.some((line) => line.includes('-t p-other')), false);
  });
});

test('replyToMessage：原发送方已经不在时明确报错，不假装发出去', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const original = store.createMessage({
      from: { channel: 'inject', name: 'gone', address: 'gone', sessionId: 'sess-gone' },
      to: { channel: 'inject', name: 'p-dst', address: 'p-dst' },
      body: 'hi'
    });
    const result = await replyToMessage(
      { messageId: original.id, text: 'reply' },
      { aiHomeDir, env: {}, createTmuxSessionAdapter: () => fakeSessionAdapter([], []), listNativePeers: () => [] }
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'sender_not_found');
  });
});

// --- 收件箱视图 -----------------------------------------------------------------

test('listInbox：按收件人过滤，open 不含已读', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const a = store.createMessage({ from: { name: 'x' }, to: { name: 'p-a', sessionId: 'sid-a' }, body: '1' });
    store.createMessage({ from: { name: 'x' }, to: { name: 'p-b', sessionId: 'sid-b' }, body: '2' });
    store.claim(a.id);
    store.settleDelivered(a, {});
    store.markRead(a.id);

    assert.equal(listInbox({ aiHomeDir, target: 'p-a' }).length, 0);
    assert.equal(listInbox({ aiHomeDir, target: 'p-b' }).length, 1);
    assert.equal(listInbox({ aiHomeDir, state: 'all' }).length, 2);
  });
});

// --- webui-chat 通道 ------------------------------------------------------------

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const route = routes.find((item) => url.includes(item.match)
      && (item.method || 'GET') === method
      && (item.when ? item.when(body) : true));
    const reply = route ? route.reply : { status: 404, body: { error: 'not_found' } };
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => reply.body
    };
  };
  impl.calls = calls;
  return impl;
}

test('webui-chat：列会话时过滤 closed，标题取 policy.title', async () => {
  const { createWebuiChatAdapter } = require('../lib/cli/services/peer/adapters/webui-chat');
  const fetchImpl = fakeFetch([{
    match: '/v0/webui/chat/sessions',
    reply: {
      status: 200,
      body: {
        sessions: [
          { sessionId: 's-1', state: 'idle', policy: { title: '重构计划' }, updatedAt: 10 },
          { sessionId: 's-2', state: 'closed', policy: { title: '关掉的' }, updatedAt: 11 }
        ]
      }
    }
  }]);
  const adapter = createWebuiChatAdapter({ fetchImpl });
  const rows = await adapter.listSessions({ serverBaseUrl: 'http://127.0.0.1:9527', managementKey: 'k' });
  assert.deepEqual(rows.map((row) => row.sessionId), ['s-1']);
  assert.equal(rows[0].name, '重构计划');
  assert.equal(rows[0].id, 'chat:s-1');
});

test('webui-chat：空闲 turn.submit，忙则 queue.add，再退到 turn.intervene', async () => {
  const { createWebuiChatAdapter } = require('../lib/cli/services/peer/adapters/webui-chat');
  const endpoint = { serverBaseUrl: 'http://127.0.0.1:9527', managementKey: 'k' };
  const target = { sessionId: 's-1', name: 'chat' };

  const idleFetch = fakeFetch([{
    match: '/commands', method: 'POST',
    reply: { status: 202, body: { ok: true } }
  }]);
  const idle = await createWebuiChatAdapter({ fetchImpl: idleFetch })
    .send(target, 'hi', { ...endpoint, messageId: 'pm-1' });
  assert.equal(idle.ok, true);
  assert.equal(idleFetch.calls[0].body.type, 'turn.submit');
  assert.equal(idleFetch.calls[0].body.commandId, 'pm-1-submit');

  const queuedFetch = fakeFetch([
    { match: '/commands', method: 'POST', when: (b) => b.type === 'turn.submit', reply: { status: 409, body: { error: 'chat_turn_already_active' } } },
    { match: '/commands', method: 'POST', when: (b) => b.type === 'queue.add', reply: { status: 202, body: { ok: true } } }
  ]);
  const queued = await createWebuiChatAdapter({ fetchImpl: queuedFetch })
    .send(target, 'hi', { ...endpoint, messageId: 'pm-2' });
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(queuedFetch.calls[1].body.payload.policy, 'after_turn');

  const steeredFetch = fakeFetch([
    { match: '/commands', method: 'POST', when: (b) => b.type === 'turn.submit', reply: { status: 409, body: { error: 'chat_turn_already_active' } } },
    { match: '/commands', method: 'POST', when: (b) => b.type === 'queue.add', reply: { status: 422, body: { error: 'chat_queue_boundary_invalid' } } },
    { match: '/commands', method: 'POST', when: (b) => b.type === 'turn.intervene', reply: { status: 202, body: { ok: true } } }
  ]);
  const steered = await createWebuiChatAdapter({ fetchImpl: steeredFetch })
    .send(target, 'hi', { ...endpoint, messageId: 'pm-3' });
  assert.equal(steered.ok, true);
  assert.equal(steered.steered, true);
  assert.equal(steeredFetch.calls[2].body.payload.mode, 'steer_current');

  const blockedFetch = fakeFetch([
    { match: '/commands', method: 'POST', reply: { status: 409, body: { error: 'chat_turn_already_active' } } }
  ]);
  const blocked = await createWebuiChatAdapter({ fetchImpl: blockedFetch })
    .send(target, 'hi', { ...endpoint, messageId: 'pm-4' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'chat_target_busy');
});

test('webui-chat：没有 Management Key 时静默降级（不连网、不报错）', async () => {
  const { createWebuiChatAdapter } = require('../lib/cli/services/peer/adapters/webui-chat');
  const fetchImpl = fakeFetch([]);
  const adapter = createWebuiChatAdapter({ fetchImpl, readServerConfig: () => ({ port: 9527 }) });
  assert.deepEqual(await adapter.listSessions({ aiHomeDir: '/tmp/none' }), []);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- 后台补投 tick ---------------------------------------------------------------

test('peer-dispatch-daemon：一轮投递后不重复，忙则退避', async () => {
  const { startPeerDispatchDaemon } = require('../lib/server/peer-dispatch-daemon');
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const sent = [];
    const adapter = fakeSessionAdapter([ROW], sent);
    store.createMessage({
      from: { name: 'p-src' },
      to: {
        channel: 'inject', provider: 'codebuddycn', name: 'p-aih-1a2b', address: 'p-aih-1a2b',
        delivery: { cliName: 'codebuddycn', runtimeScope: SCOPE, sessionName: 'p-aih-1a2b' }
      },
      body: '后台投'
    });

    const daemon = startPeerDispatchDaemon({}, {
      aiHomeDir,
      intervalMs: 1_000_000,
      sessionAdapter: adapter,
      env: {}
    });
    try {
      const first = await daemon.tick();
      assert.equal(first.delivered, 1);
      assert.equal(sent.filter((line) => line.includes('send-keys')).length, 2);
      const second = await daemon.tick();
      assert.equal(second.attempted, 0, '已投递的消息不能被再投一次');
    } finally {
      daemon.stop();
    }
  });
});

test('peer-dispatch-daemon：目标忙时留在 pending，并记一次失败尝试', async () => {
  const { startPeerDispatchDaemon } = require('../lib/server/peer-dispatch-daemon');
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    store.createMessage({
      from: { name: 'p-src' },
      to: {
        channel: 'inject', name: 'p-busy', address: 'p-busy',
        delivery: { cliName: 'codebuddycn', runtimeScope: SCOPE, sessionName: 'p-busy' }
      },
      body: '忙'
    });
    const daemon = startPeerDispatchDaemon({}, {
      aiHomeDir,
      intervalMs: 1_000_000,
      sessionAdapter: { send: () => ({ ok: false, error: 'target_busy' }) },
      env: {}
    });
    try {
      const summary = await daemon.tick();
      assert.equal(summary.pending, 1);
      const pending = store.listMessages({ state: 'pending' });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].attempts.length, 1);
      const again = await daemon.tick();
      assert.equal(again.attempted, 0, '退避期内不再重试');
    } finally {
      daemon.stop();
    }
  });
});

// --- 通道能力表 -----------------------------------------------------------------

test('通道能力表：每条通道都声明 receive / delivery，harness 用的通道必须存在', () => {
  const { PEER_CHANNELS, HARNESS_CHANNELS } = require('../lib/cli/services/peer/adapters/registry');
  const byChannel = new Map(PEER_CHANNELS.map((row) => [row.channel, row]));
  for (const row of PEER_CHANNELS) {
    assert.ok(row.channel && row.adapter && row.label && row.note, `${row.channel} 缺字段`);
    assert.equal(typeof row.receive, 'boolean', `${row.channel} 没声明 receive`);
    assert.ok(['protocol', 'turn', 'inject'].includes(row.delivery), `${row.channel} 的 delivery 非法`);
  }
  for (const entry of HARNESS_CHANNELS) {
    assert.ok(byChannel.has(entry.channel), `${entry.provider} 用了未登记的通道 ${entry.channel}`);
  }
});

// --- CLI：inbox / read / reply --------------------------------------------------

test('aih peer inbox --self：用 AIH_PEER_SELF 认自己，输出机器可读', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const record = store.createMessage({
      from: { name: 'p-src' },
      to: { channel: 'inject', name: 'p-dst', address: 'p-dst', sessionId: 'sid-dst' },
      body: '给我自己'
    });
    const chunks = [];
    const code = await runPeerCommand(['inbox', '--self', '--json'], {
      aiHomeDir,
      env: { AIH_PEER_SELF: 'p-dst' },
      stdout: { write: (text) => chunks.push(text) },
      stderr: { write: () => {} }
    });
    assert.equal(code, 0);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].id, record.id);
    assert.equal(payload.messages[0].shortId, shortMessageId(record.id));
  });
});

test('aih peer read：全文 + 标记已读；未知 id 给错误码', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const store = createPeerStore({ aiHomeDir });
    const record = store.createMessage({ from: { name: 'p-src' }, to: { name: 'p-dst' }, body: '第一行\n第二行' });

    const chunks = [];
    const code = await runPeerCommand(['read', shortMessageId(record.id), '--json'], {
      aiHomeDir,
      env: {},
      stdout: { write: (text) => chunks.push(text) },
      stderr: { write: () => {} }
    });
    assert.equal(code, 0);
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.message.body, '第一行\n第二行');
    assert.equal(payload.message.state, 'read');

    const errChunks = [];
    const missing = await runPeerCommand(['read', 'pm-nope00', '--json'], {
      aiHomeDir,
      env: {},
      stdout: { write: (text) => errChunks.push(text) },
      stderr: { write: () => {} }
    });
    assert.equal(missing, 1);
    assert.equal(JSON.parse(errChunks.join('')).error, 'message_not_found');
  });
});

test('aih peer send --dry-run：只打印命令，收件箱里不留消息', async () => {
  await withTempAiHome(async (aiHomeDir) => {
    const sent = [];
    const adapter = fakeSessionAdapter([ROW], sent);
    const chunks = [];
    const code = await runPeerCommand(['send', 'p-aih-1a2b', '预览', '--dry-run', '--json'], {
      aiHomeDir,
      env: {},
      createTmuxSessionAdapter: () => adapter,
      listNativePeers: () => [],
      stdout: { write: (text) => chunks.push(text) },
      stderr: { write: () => {} }
    });
    assert.equal(code, 0);
    assert.equal(sent.length, 0, 'dry-run 绝不能真的注入');
    const payload = JSON.parse(chunks.join(''));
    assert.equal(payload.dryRun, true);
    assert.equal(payload.commands.length, 2);
    assert.equal(createPeerStore({ aiHomeDir }).listMessages({ state: 'all' }).length, 0);
  });
});

test('peer-dispatch-daemon：收件箱根目录取宿主的 ai_home，不跟着投影 HOME 走', () => {
  const { resolvePeerStoreRoot } = require('../lib/server/peer-dispatch-daemon');
  const realHome = nodeOs.userInfo().homedir;
  // server 从会话里启动时 aiHomeDir 会落在投影里；守护进程必须和 `aih peer` 同源。
  assert.equal(
    resolvePeerStoreRoot({ env: { HOME: '/x/.ai_home/run/auth-projections/codebuddy/acct_a' } }),
    realHome + '/.ai_home'
  );
  assert.equal(resolvePeerStoreRoot({ env: { AIH_HOME_DIR: '/custom/aih' } }), '/custom/aih');
  assert.equal(resolvePeerStoreRoot({ aiHomeDir: '/explicit' }), '/explicit');
});
