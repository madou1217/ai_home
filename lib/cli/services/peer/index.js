'use strict';

// aih peer：统一的「给另一个会话发一条消息」入口。
//
// 各 harness 的通道并不一样（见 docs/providers/peer-messaging.md）：
//   - claude 有本机 UDS 协议（native 通道，有消息 id、有投递/挂起语义）；
//   - WebUI chat runtime 有命令总线（webui-chat 通道，一次幂等命令）；
//   - 其它 harness 只有 aih 自己管的 tmux 会话 → 注入（inject 通道，代打一行字）。
//
// 投递模型（三段式）：
//
//   1. **落盘**：每条消息先进 `<aiHome>/run/peer/pending/`，拿到自己的 msg-id；
//   2. **投递**：立刻试一次；目标忙 / 不可达就留在 pending（不是丢弃）；
//   3. **补投**：`aih server` 的 tick 或 `aih peer flush` 在目标空闲后重投。
//
// 这一层只做四件事：把三条通道的「收件人」压成同一种 target、把消息落盘、按 target
// 找实现、把结果归一成 { ok, state, messageId }。新增通道 = 加一个 adapter，不动路由。

const { spawnSync: nodeSpawnSync } = require('node:child_process');

const claudeAdapter = require('./adapters/claude-uds');
const { createTmuxSessionAdapter } = require('./adapters/tmux-session');
const { createWebuiChatAdapter } = require('./adapters/webui-chat');
const {
  getHarnessChannel,
  listHarnessChannels,
  listPeerChannelRows
} = require('./adapters/registry');
const { createPeerStore, shortMessageId, attemptCountOf } = require('./store');
const { formatPeerEnvelope } = require('./envelope');
const { isQuiet } = require('./idle');

const CHANNEL_ALIASES = Object.freeze({
  native: 'native',
  uds: 'native',
  claude: 'native',
  inject: 'inject',
  session: 'inject',
  tmux: 'inject',
  chat: 'webui-chat',
  'webui-chat': 'webui-chat',
  webui: 'webui-chat'
});

// 这些错误说明目标本身没了（不是「暂时忙」）：继续留在收件箱重投只会无限重试。
const TERMINAL_DELIVERY_ERRORS = new Set([
  'session_completed',
  'session_gone',
  'session_not_found',
  'missing_session_target',
  'unsafe_session_target'
]);

const DEFAULT_MAX_ATTEMPTS_BEFORE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_CAP_MS = 60_000;

function normalizeChannel(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  return CHANNEL_ALIASES[key] || '';
}

function nativeTarget(peer) {
  return {
    id: `claude:${peer.pid}`,
    channel: 'native',
    provider: 'claude',
    name: String(peer.name || '').trim() || String(peer.pid),
    address: String(peer.pid),
    sessionId: String(peer.sessionId || '').trim(),
    cwd: String(peer.cwd || '').trim(),
    status: String(peer.status || '').trim(),
    lastActivityAt: 0,
    busy: false,
    handle: peer
  };
}

function sessionTarget(row) {
  const name = String(row && (row.targetSession || row.name) || '').trim();
  const provider = String(row && row.cliName || '').trim();
  const scope = String(row && row.runtimeScope || '').trim();
  const harness = getHarnessChannel(provider);
  const lastActivityAt = Number(row && row.lastActivityAt) || 0;
  const completed = Boolean(row && row.completed);
  return {
    // 名字在单个账号内唯一，跨账号不一定（同一个 -S 标签可以在两个账号下同名），
    // 所以 id 带上 provider + scope：精确匹配时才不会打到别的账号。
    id: `session:${provider}:${scope}:${name}`,
    channel: 'inject',
    provider,
    name,
    address: name,
    sessionId: String(row && row.agentSessionId || '').trim(),
    cwd: String(row && row.path || '').trim(),
    status: completed ? 'completed' : (row && row.live ? 'live' : 'idle'),
    lastActivityAt,
    busy: !completed && !isQuiet(lastActivityAt),
    harness: harness ? { label: harness.label, note: harness.note } : null,
    handle: row
  };
}

function chatTarget(row) {
  return {
    id: row.id || `chat:${row.sessionId}`,
    channel: 'webui-chat',
    provider: String(row.provider || 'chat').trim() || 'chat',
    name: String(row.name || row.sessionId || '').trim(),
    address: String(row.address || row.sessionId || '').trim(),
    sessionId: String(row.sessionId || '').trim(),
    cwd: String(row.cwd || '').trim(),
    status: String(row.status || 'idle').trim() || 'idle',
    lastActivityAt: Number(row.lastActivityAt) || 0,
    busy: String(row.status || 'idle').trim() !== 'idle',
    handle: row
  };
}

/**
 * 列出所有可发消息的目标。
 *
 * native 通道扫 claude 的会话登记（可选，claude 没装/没跑就没有）；
 * inject 通道扫 aih 的持久会话（跨 provider）；
 * webui-chat 通道问 chat runtime（server 没起就没有）。
 */
async function listPeerTargets(options = {}) {
  const channel = normalizeChannel(options.channel);
  const provider = String(options.provider || '').trim().toLowerCase();
  const targets = [];
  const availableChannels = [];

  if (!channel || channel === 'native') {
    try {
      const listNative = options.listNativePeers || ((deps) => claudeAdapter.listPeers(deps));
      const peers = await listNative({ env: options.env, configDirs: options.configDirs });
      for (const peer of peers) targets.push(nativeTarget(peer));
      availableChannels.push('native');
    } catch (_error) {
      // claude 没装 / 没跑：native 通道这次就是空的，不影响 inject。
    }
  }

  let sessionAdapter = null;
  if (!channel || channel === 'inject') {
    sessionAdapter = (options.createTmuxSessionAdapter || createTmuxSessionAdapter)(options.adapterDeps || {});
    const rows = sessionAdapter.listSessions({
      aiHomeDir: options.aiHomeDir,
      hostHomeDir: options.hostHomeDir,
      providers: options.providers,
      processImpl: options.processImpl,
      fs: options.fs
    });
    for (const row of rows) targets.push(sessionTarget(row));
    availableChannels.push('inject');
  }

  if (!channel || channel === 'webui-chat') {
    const chatAdapter = (options.createWebuiChatAdapter || createWebuiChatAdapter)({
      ...(options.chatAdapterDeps || {}),
      fetchImpl: options.fetchImpl,
      readServerConfig: options.readServerConfig,
      fs: options.fs
    });
    let rows = [];
    try {
      rows = await chatAdapter.listSessions({
        aiHomeDir: options.aiHomeDir,
        serverBaseUrl: options.serverBaseUrl,
        managementKey: options.managementKey,
        fs: options.fs
      });
    } catch (_error) {
      rows = [];
    }
    for (const row of rows) targets.push(chatTarget(row));
    if (rows.length) availableChannels.push('webui-chat');
  }

  const filtered = targets.filter((target) => (!provider || target.provider === provider));
  return {
    targets: filtered,
    channels: availableChannels,
    sessionAdapter
  };
}

/**
 * 按 id → 名字 → 原生会话 id → 唯一前缀 的顺序定位。
 * 多义时返回 { ambiguous: [...] }，不替用户猜。
 */
function findPeerTarget(targets, wanted) {
  const key = String(wanted || '').trim();
  if (!key) return { target: null, ambiguous: [] };
  const list = Array.isArray(targets) ? targets : [];
  const exact = list.find((target) => target.id === key);
  if (exact) return { target: exact, ambiguous: [] };
  const byName = list.filter((target) => target.name === key);
  if (byName.length === 1) return { target: byName[0], ambiguous: [] };
  if (byName.length > 1) return { target: null, ambiguous: byName };
  const bySessionId = list.filter((target) => target.sessionId && target.sessionId === key);
  if (bySessionId.length === 1) return { target: bySessionId[0], ambiguous: [] };
  if (bySessionId.length > 1) return { target: null, ambiguous: bySessionId };
  const byAddress = list.filter((target) => target.address && target.address === key);
  if (byAddress.length === 1) return { target: byAddress[0], ambiguous: [] };
  if (byAddress.length > 1) return { target: null, ambiguous: byAddress };
  const byPrefix = list.filter((target) => target.name && target.name.startsWith(key));
  if (byPrefix.length === 1) return { target: byPrefix[0], ambiguous: [] };
  return { target: null, ambiguous: byPrefix };
}

/** 消息里要持久化的收件人/发件人描述符（重投所需的全部信息）。 */
function targetDescriptor(target) {
  const base = {
    channel: String(target.channel || '').trim(),
    provider: String(target.provider || '').trim(),
    name: String(target.name || '').trim(),
    address: String(target.address || '').trim(),
    sessionId: String(target.sessionId || '').trim()
  };
  if (target.channel === 'inject') {
    const row = target.handle || {};
    return {
      ...base,
      delivery: {
        cliName: String(row.cliName || target.provider || '').trim(),
        runtimeScope: String(row.runtimeScope || '').trim(),
        sessionName: String(row.targetSession || row.name || target.address || '').trim()
      }
    };
  }
  if (target.channel === 'native') {
    const peer = target.handle || {};
    return { ...base, delivery: { socket: String(peer.socket || '').trim() } };
  }
  return base;
}

/**
 * 「我是谁」：优先显式 `AIH_PEER_SELF`，其次 tmux 当前会话名。
 * 不在会话里就返回 null（发送方显示成 aih-cli，回复时靠名字反查）。
 */
function resolveSelfIdentity(options = {}) {
  const env = options.env || process.env;
  const explicit = String(env.AIH_PEER_SELF || '').trim();
  if (explicit) return { channel: 'inject', name: explicit, address: explicit, sessionId: '' };
  if (!String(env.TMUX || '').trim()) return null;
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  let result;
  try {
    result = spawnSyncImpl('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf8',
      timeout: 1_500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_error) {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const name = String(result.stdout || '').trim();
  if (!name) return null;
  return { channel: 'inject', name, address: name, sessionId: '' };
}

/** 发送方描述符：`--from` 能对上已知目标就用目标的完整身份，否则按自由文本记。 */
function resolveSender(input, targets, options) {
  const wanted = String(input.fromAddress || '').trim();
  if (wanted) {
    const found = findPeerTarget(targets, wanted);
    if (found.target) return targetDescriptor(found.target);
    return { channel: '', provider: '', name: wanted, address: wanted, sessionId: '' };
  }
  const self = options.selfIdentity !== undefined
    ? options.selfIdentity
    : resolveSelfIdentity({ env: options.env, spawnSync: options.spawnSync });
  if (self) return self;
  return { channel: '', provider: '', name: 'aih-cli', address: 'aih-cli', sessionId: '' };
}

/**
 * 回复时定位原发送方：按 sessionId → 名字 → 地址 → id 逐个试，取第一个**唯一**命中。
 *
 * 为什么不能只挑一个字段：agent session id 并不保证唯一。实测 codebuddy 的多个
 * pane 会共享同一个 `agentSessionId`（未绑定的 pane 会落到最近一次会话上），
 * 只按 sessionId 找就会多义。名字（tmux 会话名）反而是注入通道最可靠的地址。
 */
function resolveSenderTarget(targets, sender) {
  const source = sender && typeof sender === 'object' ? sender : {};
  const keys = [source.sessionId, source.name, source.address, source.id]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const key of keys) {
    const found = findPeerTarget(targets, key);
    if (found.target) return found.target;
  }
  return null;
}

function renderMessageText(record, options = {}) {
  if (options.noEnvelope === true) return record.body;
  return formatPeerEnvelope({
    id: shortMessageId(record.id),
    from: record.from,
    body: record.body
  });
}

function createStoreFor(options = {}) {
  if (options.store) return options.store;
  return createPeerStore({ fs: options.fs, aiHomeDir: options.aiHomeDir, now: options.now });
}

function backoffFor(attempts) {
  const count = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** (count - 1)));
}

/**
 * 按记录里的 `to` 投一次。返回 { ok, channel, error?, channelMessageId? }。
 *
 * 重投时**不重新列会话**：`to.delivery` 里已经带着 cliName/runtimeScope/sessionName
 * （inject）、socket（native）或 sessionId（webui-chat），够用来直接定位。
 */
async function deliverRecord(record, options = {}) {
  const to = record.to || {};
  const text = renderMessageText(record, options);
  const channel = String(to.channel || '').trim();

  if (channel === 'native') {
    const socket = String(to.delivery && to.delivery.socket || '').trim();
    const pid = Number(to.address) || 0;
    if (!socket || !pid) return { ok: false, error: 'session_gone' };
    if (!options.dryRun && !claudeAdapter.isProcessAlive(pid)) return { ok: false, error: 'session_gone' };
    const sendNative = options.sendNative || ((peer, body, opts) => claudeAdapter.sendToPeer(peer, body, opts));
    try {
      const result = await sendNative(
        { pid, socket, name: to.name, sessionId: to.sessionId },
        text,
        {
          mode: options.mode || '',
          fromAddress: String(record.from && record.from.address || ''),
          dryRun: options.dryRun === true
        }
      );
      return {
        ok: true,
        channel: 'native',
        channelMessageId: result && result.msgId,
        ...(result && result.frames ? { frames: result.frames } : {}),
        ...(options.dryRun ? { dryRun: true } : {})
      };
    } catch (error) {
      return { ok: false, error: 'native_send_failed', message: String(error && error.message || error) };
    }
  }

  if (channel === 'webui-chat') {
    const chatAdapter = (options.createWebuiChatAdapter || createWebuiChatAdapter)({
      ...(options.chatAdapterDeps || {}),
      fetchImpl: options.fetchImpl,
      readServerConfig: options.readServerConfig,
      fs: options.fs
    });
    return chatAdapter.send(
      { sessionId: to.sessionId, name: to.name, address: to.address },
      text,
      {
        messageId: record.id,
        dryRun: options.dryRun === true,
        aiHomeDir: options.aiHomeDir,
        serverBaseUrl: options.serverBaseUrl,
        managementKey: options.managementKey,
        fs: options.fs
      }
    );
  }

  const delivery = to.delivery || {};
  const row = {
    cliName: String(delivery.cliName || '').trim(),
    runtimeScope: String(delivery.runtimeScope || '').trim(),
    targetSession: String(delivery.sessionName || '').trim(),
    name: String(delivery.sessionName || '').trim(),
    completed: false,
    // 立即投递时列表刚拿到的活动时间是新鲜信号，能省一次 tmux 探测；
    // 补投时没有这个字段（0），会真去问一次。
    lastActivityAt: Number(options.lastActivityAt) || 0
  };
  if (!row.cliName || !row.runtimeScope || !row.targetSession) {
    return { ok: false, error: 'missing_session_target' };
  }
  const adapter = options.sessionAdapter
    || (options.createTmuxSessionAdapter
      ? options.createTmuxSessionAdapter(options.adapterDeps || {})
      : createTmuxSessionAdapter(options.adapterDeps || {}));
  return adapter.send(row, text, {
    env: options.env,
    processImpl: options.processImpl,
    dryRun: options.dryRun === true,
    quietMs: options.quietMs,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
    sleep: options.sleep,
    now: options.now,
    readActivityAt: options.readActivityAt,
    waitForQuiet: options.waitForQuiet
  });
}

function isTerminalDeliveryError(error) {
  return TERMINAL_DELIVERY_ERRORS.has(String(error || '').trim());
}

/**
 * 发一条消息：落盘 → 立刻投一次 → 投不出去就留在收件箱。
 *
 * 返回值里 `ok` 表示**消息是否已经安全落盘**（而不是是否已送达）：
 * `state: 'delivered'` 是已送达，`state: 'pending'` 是排队等空闲。
 */
async function sendPeerMessage(input = {}, options = {}) {
  const body = String(input.body == null ? input.text == null ? '' : input.text : input.body);
  if (!body.trim()) return { ok: false, error: 'empty_text', message: '消息正文不能为空。' };

  const listing = await listPeerTargets({
    ...options,
    channel: input.channel || '',
    provider: input.provider || ''
  });
  const found = findPeerTarget(listing.targets, input.target);
  if (!found.target) {
    if (found.ambiguous.length) {
      return {
        ok: false,
        error: 'ambiguous_target',
        message: `「${input.target}」匹配到多个目标，用完整 id 再试一次：`,
        candidates: found.ambiguous
      };
    }
    return {
      ok: false,
      error: 'target_not_found',
      message: `没有匹配 ${input.target} 的会话；用 aih peer list 看看现在有哪些。`
    };
  }

  const target = found.target;
  const from = resolveSender(input, listing.targets, options);
  const dryRun = input.dryRun === true;
  // `--wait <秒>` 覆盖注入通道的安静期等待上限；0 表示只入队、不等。
  const waitMs = input.wait == null || input.wait === ''
    ? undefined
    : Math.max(0, Number(input.wait) * 1000);

  if (dryRun) {
    const preview = {
      id: 'pm-dryrun',
      from,
      to: targetDescriptor(target),
      body
    };
    const result = await deliverRecord(preview, {
      ...options,
      sessionAdapter: listing.sessionAdapter,
      noEnvelope: input.noEnvelope === true,
      mode: input.mode,
      // dry-run 必须一路传到底：否则注入通道会真的把字打进 pane。
      dryRun: true,
      waitForQuiet: false
    });
    return { ...result, target, channel: target.channel, dryRun: true };
  }

  const store = createStoreFor(options);
  const record = store.createMessage({
    from,
    to: targetDescriptor(target),
    body,
    replyTo: input.replyTo || ''
  });
  if (!record) {
    return {
      ok: false,
      error: 'store_unavailable',
      target,
      message: '收件箱不可写（run/peer），消息没有发出去。'
    };
  }

  const claimed = store.claim(record.id);
  const working = claimed.record || record;
  const result = await deliverRecord(working, {
    ...options,
    sessionAdapter: listing.sessionAdapter,
    noEnvelope: input.noEnvelope === true,
    mode: input.mode,
    lastActivityAt: target.lastActivityAt,
    ...(waitMs === undefined ? {} : { timeoutMs: waitMs })
  });

  if (result.ok) {
    const settled = store.settleDelivered(working, {
      channelMessageId: String(result.channelMessageId || '')
    }) || working;
    return {
      ok: true,
      state: 'delivered',
      channel: target.channel,
      target,
      messageId: record.id,
      shortId: shortMessageId(record.id),
      channelMessageId: String(result.channelMessageId || ''),
      deliveredAt: settled.deliveredAt,
      ...(result.commands ? { commands: result.commands } : {}),
      ...(result.queued ? { queued: true } : {}),
      ...(result.steered ? { steered: true } : {})
    };
  }

  if (isTerminalDeliveryError(result.error)) {
    store.settleFailed(working, result.error);
    return {
      ok: true,
      state: 'failed',
      channel: target.channel,
      target,
      messageId: record.id,
      shortId: shortMessageId(record.id),
      reason: result.error,
      message: result.message || `投递失败：${result.error}`
    };
  }

  const pending = store.settlePending(working, result.error, {
    // 用总次数而不是 `attempts.length`：明细数组有截断上限，读长度会让退避回到 3s。
    retryAfterMs: backoffFor(attemptCountOf(working) + 1)
  }) || working;
  return {
    ok: true,
    state: 'pending',
    queued: true,
    channel: target.channel,
    target,
    messageId: record.id,
    shortId: shortMessageId(record.id),
    nextAttemptAt: pending.nextAttemptAt,
    reason: result.error || '',
    message: result.message || '目标现在忙，消息已入队，空闲后自动投递。'
  };
}

/**
 * 回复一条消息：解析原发送方 → 重新发一条，带 replyTo。
 *
 * 发送方已经不在时**不**把消息塞进收件箱：用户会以为发出去了。直接报错。
 */
async function replyToMessage(input = {}, options = {}) {
  const store = createStoreFor(options);
  const found = store.findMessage(input.messageId);
  if (!found.record) {
    if (found.ambiguous.length) {
      return {
        ok: false,
        error: 'ambiguous_message',
        message: `「${input.messageId}」匹配到多条消息，用更长的 id 前缀：`,
        candidates: found.ambiguous.map((record) => ({ id: record.id, shortId: shortMessageId(record.id) }))
      };
    }
    return {
      ok: false,
      error: 'message_not_found',
      message: `找不到消息 ${input.messageId}；用 aih peer inbox 看看收件箱。`
    };
  }

  const original = found.record;
  const sender = original.from || {};
  const listing = await listPeerTargets({ ...options, channel: '' });
  const resolved = resolveSenderTarget(listing.targets, sender);
  if (!resolved) {
    return {
      ok: false,
      error: 'sender_not_found',
      message: `原发送方「${sender.name || sender.sessionId || '未知'}」已经不在了；用 aih peer send 直接发给它。`,
      original: { id: original.id, shortId: shortMessageId(original.id), from: sender }
    };
  }

  const result = await sendPeerMessage({
    ...input,
    target: resolved.id,
    body: input.body == null ? input.text : input.body,
    replyTo: original.id,
    fromAddress: input.fromAddress || ''
  }, { ...options, sessionAdapter: listing.sessionAdapter });

  if (result.ok) store.markRead(original.id);
  return { ...result, replyTo: original.id, originalSender: sender };
}

/** 收件箱：默认「还没处理的」= pending + 已送达未读。 */
function listInbox(options = {}) {
  const store = createStoreFor(options);
  return store.listMessages({
    state: options.state || 'open',
    target: options.target || '',
    limit: options.limit
  });
}

/**
 * 补投一轮：把 pending 里到点的消息按目标通道再投一次。
 *
 * server 的 tick 和 `aih peer flush` 共用这一个函数；并发由 store 的 rename 抢锁兜底。
 */
async function flushPending(options = {}) {
  const store = createStoreFor(options);
  store.recoverStaleInflight();
  store.expireStale(Number(options.expireMs) || DEFAULT_MAX_ATTEMPTS_BEFORE_EXPIRY_MS);

  const at = typeof options.now === 'function' ? options.now() : Date.now();
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : 20;
  // 先全量取 pending 再按退避时刻过滤：如果先 limit 再过滤，排在前面的一堆退避
  // 消息会把后面已经到点的挤掉。
  const candidates = store.listMessages({ state: 'pending' })
    .filter((record) => (Number(record.nextAttemptAt) || 0) <= at)
    .slice(0, limit);

  const summary = { attempted: 0, delivered: 0, pending: 0, failed: 0 };
  for (const record of candidates) {
    const claimed = store.claim(record.id);
    if (!claimed.record) continue;
    summary.attempted += 1;
    const result = await deliverRecord(claimed.record, options);
    if (result.ok) {
      store.settleDelivered(claimed.record, { channelMessageId: String(result.channelMessageId || '') });
      summary.delivered += 1;
      continue;
    }
    if (isTerminalDeliveryError(result.error)) {
      store.settleFailed(claimed.record, result.error);
      summary.failed += 1;
      continue;
    }
    store.settlePending(claimed.record, result.error, {
      // 用总次数而不是 `attempts.length`：明细数组有截断上限，读长度会让退避回到 3s。
      retryAfterMs: backoffFor(attemptCountOf(claimed.record) + 1)
    });
    summary.pending += 1;
  }
  return summary;
}

/** 每个 harness 的跨会话能力表（与发送/补全同源，见 adapters/registry.js）。 */
function listPeerChannels() {
  return listHarnessChannels();
}

/** 通道能力表：每条通道怎么投递（protocol / turn / inject）。 */
function listPeerCapabilities() {
  return listPeerChannelRows();
}

function formatIdleCell(target) {
  if (target.channel === 'webui-chat') return target.busy ? 'busy' : 'idle';
  if (target.status === 'completed') return 'gone';
  return target.busy ? 'busy' : 'idle';
}

function formatPeerTarget(target, options = {}) {
  const unread = Number(options.unread) || 0;
  return [
    String(target.provider || '-').padEnd(12),
    String(target.channel || '-').padEnd(11),
    String(target.status || '-').padEnd(9),
    formatIdleCell(target).padEnd(5),
    String(unread || '-').padEnd(6),
    String(target.name || '').padEnd(24),
    target.cwd || ''
  ].join('  ');
}

module.exports = {
  CHANNEL_ALIASES,
  normalizeChannel,
  listPeerTargets,
  listPeerChannels,
  listPeerCapabilities,
  findPeerTarget,
  targetDescriptor,
  resolveSelfIdentity,
  resolveSenderTarget,
  deliverRecord,
  sendPeerMessage,
  replyToMessage,
  listInbox,
  flushPending,
  shortMessageId,
  formatPeerTarget,
  formatIdleCell
};
