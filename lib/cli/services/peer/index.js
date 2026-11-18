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
const { formatPeerEnvelope, formatNativePeerEnvelope } = require('./envelope');
const { isQuiet } = require('./idle');
const { messageMetadata, notificationStatus, backoffFor } = require('./delivery-policy');
const { targetKey, sameSender } = require('./target-gate');

// A retry round shares its activity observations across messages and ticks.
// Recreating an adapter per record would classify every first probe as busy.
let defaultSessionAdapter;
function resolveSessionAdapter(options) {
  if (options.sessionAdapter) return options.sessionAdapter;
  if (options.createTmuxSessionAdapter) return options.createTmuxSessionAdapter(options.adapterDeps || {});
  if (options.adapterDeps) return createTmuxSessionAdapter(options.adapterDeps);
  if (!defaultSessionAdapter) defaultSessionAdapter = createTmuxSessionAdapter();
  return defaultSessionAdapter;
}

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
  const format = record.to && record.to.channel === 'native' ? formatNativePeerEnvelope : formatPeerEnvelope;
  return format({
    ...record,
    id: shortMessageId(record.id),
    now: typeof options.now === 'function' ? options.now() : Date.now()
  });
}

function createStoreFor(options = {}) {
  if (options.store) return options.store;
  return createPeerStore({ fs: options.fs, aiHomeDir: options.aiHomeDir, now: options.now });
}

/**
 * 按记录里的 `to` 投一次。返回 { ok, channel, error?, channelMessageId? }。
 *
 * 重投时**不重新列会话**：`to.delivery` 里已经带着 cliName/runtimeScope/sessionName
 * （inject）、socket（native）或 sessionId（webui-chat），够用来直接定位。
 */
async function deliverRecord(record, options = {}) {
  const beforeTransmit = () => options.dryRun ? null : createStoreFor(options).checkDelivery(record);
  const checked = beforeTransmit();
  if (checked) return checked;
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
      const current = beforeTransmit();
      if (current) return current;
      const result = await sendNative(
        { pid, socket, name: to.name, sessionId: to.sessionId, configDir: to.delivery && to.delivery.configDir },
        text,
        {
          mode: options.mode || '',
          env: options.env,
          fromAddress: String(record.from && record.from.address || ''),
          dryRun: options.dryRun === true,
          beforeWrite: beforeTransmit
        }
      );
      if (result && (result.skipped || result.ok === false)) return { ...result, channel: 'native' };
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
    if (!options.dryRun) {
      let probe;
      try { probe = await chatAdapter.probe(to, options); }
      catch (_error) { return { ok: false, error: 'target_probe_unavailable' }; }
      if (!probe || !probe.ok) return { ok: false, error: 'target_probe_unavailable' };
      if (probe.state !== 'idle') return { ok: false, error: probe.state === 'busy' || probe.state === 'running' ? 'chat_target_busy' : 'target_state_unknown' };
    }
    return chatAdapter.send(
      { sessionId: to.sessionId, name: to.name, address: to.address },
      text,
      {
        messageId: record.id,
        beforeTransmit,
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
  const adapter = resolveSessionAdapter(options);
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
    waitForQuiet: options.waitForQuiet,
    beforeInject: beforeTransmit
  });
}

function isTerminalDeliveryError(error) {
  return TERMINAL_DELIVERY_ERRORS.has(String(error || '').trim());
}

function queuedResult(record, target, reason) {
  return { ok: true, state: record.state, notificationState: record.notificationState || 'waiting',
    queued: true, channel: target.channel, target, messageId: record.id, shortId: shortMessageId(record.id),
    reason, message: '消息已保存；自动通知遵守目标等待、有效期和重试限制。' };
}

function settleDeliveryResult(store, working, result) {
  if (result.skipped && !result.ok) return store.settleSkipped(working, result.error);
  if (result.ok) return store.settleDelivered(working, {
    channelMessageId: String(result.channelMessageId || ''), ...(result.skipped ? { countAttempt: false } : {})
  });
  if (isTerminalDeliveryError(result.error)) return store.settleFailed(working, result.error, { countAttempt: false });
  return store.settlePending(working, result.error || 'transport_failed');
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

  let metadata;
  try { metadata = messageMetadata(input, typeof options.now === 'function' ? options.now() : Date.now()); }
  catch (error) { return { ok: false, error: error.message, message: '消息元数据或有效期不合法。' }; }
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
      createdAt: typeof options.now === 'function' ? options.now() : Date.now(),
      ...metadata,
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
  const created = store.createMessageResult({
    ...metadata,
    from,
    to: targetDescriptor(target),
    body,
    replyTo: input.replyTo || ''
  });
  const record = created.record;
  if (!record) {
    return {
      ok: false,
      error: created.error || 'store_unavailable',
      target,
      message: '收件箱不可写（run/peer），消息没有发出去。'
    };
  }

  // Avoid even entering Claim while a shared target is cooling down/waiting.
  let gate;
  try { gate = store.readTargetGate(record.to); }
  catch (_error) { return queuedResult(record, target, 'target_gate_unavailable'); }
  const status = notificationStatus(record, typeof options.now === 'function' ? options.now() : Date.now(), gate);
  if (status.notificationState !== 'ready') return queuedResult({ ...record, ...status }, target, status.waitingReason);
  const claimed = store.claim(record.id);
  if (!claimed.record) {
    return { ok: true, state: 'pending', queued: true, channel: target.channel, target,
      messageId: record.id, shortId: shortMessageId(record.id),
      notificationState: claimed.notificationState || 'waiting', reason: claimed.reason || claimed.error || 'target_inflight',
      message: '消息已保存，等待目标可接收时通知。' };
  }
  const working = claimed.record;
  let result;
  try { result = await deliverRecord(working, {
    ...options,
    sessionAdapter: listing.sessionAdapter,
    noEnvelope: input.noEnvelope === true,
    mode: input.mode,
    lastActivityAt: target.lastActivityAt,
    ...(waitMs === undefined ? {} : { timeoutMs: waitMs })
  }); } catch (error) { result = { ok: false, error: 'target_probe_unavailable', message: error.message }; }

  const settled = settleDeliveryResult(store, working, result);
  return {
    ok: true, state: settled ? settled.state : working.state,
    notificationState: settled && settled.notificationState || 'waiting',
    channel: target.channel, target, messageId: record.id, shortId: shortMessageId(record.id),
    channelMessageId: String(result.channelMessageId || ''),
    deliveredAt: settled && settled.deliveredAt || 0, nextAttemptAt: settled && settled.nextAttemptAt || 0,
    queued: !settled || settled.state === 'pending', reason: settled && settled.waitingReason || result.error || '',
    message: result.message || '', ...(result.commands ? { commands: result.commands } : {})
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

/** Lifecycle mutations are local, identity-checked, and never transmit. */
function mutatePeerMessage(input = {}, options = {}) {
  const store = createStoreFor(options);
  const found = store.findMessage(input.messageId);
  if (!found.record) return { ok: false, error: found.ambiguous.length ? 'ambiguous_message' : 'message_not_found',
    candidates: found.ambiguous.map((record) => ({ id: record.id, shortId: shortMessageId(record.id) })) };
  const storedSender = found.record.from || {};
  let from = input.from;
  if (!from && input.fromAddress) {
    const wanted = String(input.fromAddress).trim();
    if (![storedSender.name, storedSender.address, storedSender.sessionId].some((value) => value && value === wanted)) {
      return { ok: false, error: 'sender_mismatch' };
    }
    // The unique message, not other mail's older/enriched variants, owns identity.
    from = storedSender;
  }
  if (!from) {
    const self = resolveSender(input, [], options);
    const exactAddress = self.address && self.address === storedSender.address;
    const exactSession = self.sessionId && self.sessionId === storedSender.sessionId;
    from = sameSender(self, storedSender) || exactAddress || exactSession ? storedSender : self;
  }
  const expected = { from, to: input.to || found.record.to,
    autoDeliverUntil: input.autoDeliverUntil, expiresAt: input.expiresAt, resetAttempts: input.resetAttempts === true };
  return input.action === 'cancel' ? store.cancelMessage(found.record.id, expected)
    : store.resumeMessage(found.record.id, expected);
}

function cancelPeerMessage(input = {}, options = {}) {
  return mutatePeerMessage({ ...input, action: 'cancel' }, options);
}

function resumePeerMessage(input = {}, options = {}) {
  return mutatePeerMessage({ ...input, action: 'resume' }, options);
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
  store.reconcileRead();
  store.reconcileSupersedes();
  store.expireStale();
  const at = typeof options.now === 'function' ? options.now() : Date.now();
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.min(100, Math.floor(Number(options.limit))) : 20;
  const byTarget = new Map();
  for (const record of store.listMessages({ state: 'pending' })) {
    if (record.receiptError || record.notificationState !== 'ready') continue;
    const key = targetKey(record.to);
    if (!byTarget.has(key)) byTarget.set(key, record);
  }
  const candidates = [...byTarget.values()].map((record) => {
    try { return { record, gate: store.readTargetGate(record.to) }; }
    catch (_error) { return null; }
  }).filter((item) => item && notificationStatus(item.record, at, item.gate).notificationState === 'ready')
    .sort((left, right) => left.gate.lastProbeAt - right.gate.lastProbeAt
      || left.record.createdAt - right.record.createdAt || left.record.id.localeCompare(right.record.id))
    .slice(0, limit);
  const summary = { attempted: 0, delivered: 0, pending: 0, failed: 0, probed: 0, manual: 0 };
  for (const { record } of candidates) {
    const claimed = store.claim(record.id);
    if (!claimed.record) continue;
    summary.probed += 1;
    let result;
    try { result = await deliverRecord(claimed.record, { ...options, timeoutMs: options.timeoutMs ?? 0 }); }
    catch (error) { result = { ok: false, error: 'target_probe_unavailable', message: error.message }; }
    const settled = settleDeliveryResult(store, claimed.record, result);
    if (!settled) continue;
    summary.attempted += Math.max(0, attemptCountOf(settled) - attemptCountOf(claimed.record));
    if (settled.state === 'delivered' || settled.state === 'read') summary.delivered += 1;
    else if (settled.state === 'failed') summary.failed += 1;
    else summary.pending += 1;
    if (settled.notificationState === 'manual') summary.manual += 1;
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
  renderMessageText,
  targetKey,
  notificationStatus,
  messageMetadata,
  backoffFor,
  sendPeerMessage,
  cancelPeerMessage,
  resumePeerMessage,
  replyToMessage,
  listInbox,
  flushPending,
  shortMessageId,
  formatPeerTarget,
  formatIdleCell
};
