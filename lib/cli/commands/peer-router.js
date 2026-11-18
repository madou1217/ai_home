'use strict';

// `aih peer` 的路由：只做参数解析与展示，通道选择/投递在 lib/cli/services/peer。
//
//   aih peer                            列出可发消息的会话（等价 list）
//   aih peer list [--json] [--provider P] [--channel C]
//   aih peer channels                   每条通道怎么投递（能力表）
//   aih peer send <目标> <正文...> [--reply-to id] [--wait 秒] [--dry-run]
//   aih peer inbox [--target 名字] [--self] [--unread] [--limit N]
//   aih peer read <msg-id>
//   aih peer reply <msg-id> <正文...>
//   aih peer flush [--wait 秒]

const {
  resolvePeerHostHome,
  resolvePeerAiHomeDir,
  listClaudeConfigDirs
} = require('../services/peer/scope');
// 允许注入：路由只做参数解析与展示，测试不需要真的连 tmux / claude / server。
const defaultPeerService = require('../services/peer');
const { readableMetadata } = require('../services/peer/envelope');
const { autoDeliverUntilOf, retryAttempts } = require('../services/peer/delivery-policy');
const { createPeerStore, shortMessageId, attemptCountOf } = require('../services/peer/store');

const USAGE = [
  'aih peer [list] [--json] [--provider <p>] [--channel <c>]',
  'aih peer channels                # 每条通道怎么投递（能力表）',
  'aih peer send <名字|id|pid|会话id> "<正文>" [--reply-to <msg-id>] [--wait <秒>] [--from <地址>] [--dry-run] [--json]',
  'aih peer inbox [--target <名字|id>] [--self] [--unread] [--limit <n>] [--json]',
  'aih peer read <msg-id> [--json]',
  'aih peer reply <msg-id> "<正文>" [--dry-run] [--json]',
  'aih peer cancel <消息id> [--from <发送方>] [--json]  # 仅撤回尚未送达的通知',
  'aih peer resume <消息id> [--from <发送方>] [--auto-deliver-until <时间>] [--expires-at <时间>] [--reset-attempts] [--json]',
  'aih peer send ... --subject <主题> --purpose <为什么联系> --action <希望对方做什么> [--summary <摘要>] [--reply-policy required|optional|none]',
  'aih peer send ... [--auto-deliver-until <Unix毫秒|ISO时间>] [--expires-at <Unix毫秒|ISO时间>] [--supersedes <旧消息id>]',
  'aih peer flush [--wait <秒>] [--json] # 手动检查一轮；默认最多观察3秒/目标，0=单次安全检查'
].join('\n  ');

const STATE_LABELS = Object.freeze({
  pending: '待投递',
  delivered: '已送达',
  read: '已读',
  failed: '需处理',
  waiting: '等待目标', ready: '待通知', manual: '手动处理', canceled: '已撤回', expired: '已过期'
});

// 表头和数据行用同一组宽度，避免手写空格导致列漂移。
const TARGET_COLUMNS = Object.freeze([12, 11, 9, 5, 6, 24]);
const TARGET_HEADER = ['PROVIDER', 'CHANNEL', 'STATUS', 'IDLE', 'UNREAD', 'NAME']
  .map((label, index) => label.padEnd(TARGET_COLUMNS[index]))
  .concat('CWD')
  .join('  ');
const INBOX_HEADER = [
  'ID'.padEnd(11), 'STATE'.padEnd(8), 'FROM'.padEnd(20),
  'TO'.padEnd(20), 'AGE'.padEnd(4), 'BODY'
].join('  ');
const HARNESS_HEADER = [
  'PROVIDER'.padEnd(12), 'CHANNEL'.padEnd(10), 'HARNESS'.padEnd(16), 'NOTE'
].join('  ');
const CAPABILITY_HEADER = [
  'CHANNEL'.padEnd(13), 'DELIVERY'.padEnd(8), 'RECEIVE'.padEnd(7), 'NOTE'
].join('  ');

function printHelp(write) {
  write([
    '\x1b[36maih peer\x1b[0m - 给另一个会话发消息 / 看自己的收件箱',
    '',
    '\x1b[90m用法:\x1b[0m',
    `  ${USAGE}`,
    '',
    '\x1b[90m通道:\x1b[0m',
    '  native      claude 的本机 UDS 协议：有 msg_id，收件方按策略投递或挂起',
    '  inject      其它 harness：由 aih 把一行信封敲进该会话的 tmux pane',
    '  webui-chat  WebUI chat runtime 的命令总线：空闲开一轮，忙则排队',
    '',
    '\x1b[90m投递语义:\x1b[0m',
    '  消息先保存。目标忙或有草稿时按目标等待，不打断当前工作；新消息也遵守等待。',
    '  默认自动通知30分钟，之后仍保留原文供手动处理；内容截止时间单独指定。',
    '  请写清人能理解的主题、缘由、待办与回复要求；未写的内容不会推断。',
    '  真实传输失败最多五次；忙碌/草稿/未知探测不算发送。撤回请用 cancel，而非发送“撤回”正文。',
    '',
    '\x1b[90m例子:\x1b[0m',
    '  aih peer                                    # 看看能发给谁',
    '  aih peer send 同事 "请核对原始数据" --subject "发布前核对" --purpose "避免金额出错" --action "核对后告诉我差异" --reply-policy optional',
    '  aih peer send p-aih-1a2b "继续"              # aih 管的任意会话（inject）',
    '  aih peer inbox --self                        # 看发给我的消息',
    '  aih peer reply a1b2c3d4 "收到，正在跑"        # 回给原发送方',
    ''
  ].join('\n'));
}

function parseArgs(argv = []) {
  const list = argv.map((item) => String(item));
  const options = {
    action: '',
    target: '',
    text: [],
    json: false,
    dryRun: false,
    provider: '',
    channel: '',
    mode: '',
    fromAddress: '',
    replyTo: '',
    self: false,
    unread: false,
    noEnvelope: false,
    state: '',
    limit: 0,
    wait: null,
    subject: undefined, summary: undefined, purpose: undefined, actionMetadata: undefined, replyPolicy: undefined,
    autoDeliverUntil: undefined, expiresAt: undefined, supersedes: undefined, resetAttempts: false,
    help: false
  };
  const valueFlags = new Set([
    '--provider', '--channel', '--mode', '--from',
    '--target', '--reply-to', '--limit', '--wait', '--state',
    '--subject', '--summary', '--purpose', '--action', '--reply-policy', '--auto-deliver-until', '--expires-at', '--deadline', '--supersedes'
  ]);
  const assign = (flag, value) => {
    const text = String(value == null ? '' : value).trim();
    if (flag === '--provider') options.provider = text;
    if (flag === '--channel') options.channel = text;
    if (flag === '--mode') options.mode = text;
    if (flag === '--from') options.fromAddress = text;
    if (flag === '--target') options.target = text;
    if (flag === '--reply-to') options.replyTo = text;
    if (flag === '--state') options.state = text;
    if (flag === '--limit') options.limit = Number(text) || 0;
    if (flag === '--wait') options.wait = Number(text) || 0;
    const metadataFlags = { '--subject': 'subject', '--summary': 'summary', '--purpose': 'purpose',
      '--action': 'actionMetadata', '--reply-policy': 'replyPolicy', '--auto-deliver-until': 'autoDeliverUntil',
      '--expires-at': 'expiresAt', '--deadline': 'expiresAt', '--supersedes': 'supersedes' };
    if (metadataFlags[flag]) options[metadataFlags[flag]] = String(value == null ? '' : value);

  };
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === '--help' || token === '-h' || token === 'help') { options.help = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--dry-run') { options.dryRun = true; continue; }
    if (token === '--self') { options.self = true; continue; }
    if (token === '--unread') { options.unread = true; continue; }
    if (token === '--reset-attempts') { options.resetAttempts = true; continue; }
    if (token === '--no-envelope') { options.noEnvelope = true; continue; }
    if (valueFlags.has(token)) {
      const value = list[index + 1];
      if (value != null && !value.startsWith('--')) {
        assign(token, value);
        index += 1;
      }
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (token.startsWith('--') && equalsIndex > 2) {
      const flag = token.slice(0, equalsIndex);
      if (valueFlags.has(flag)) { assign(flag, token.slice(equalsIndex + 1)); continue; }
    }
    if (token.startsWith('-') && !options.action) continue;
    if (!options.action) { options.action = token; continue; }
    if (!options.target) { options.target = token; continue; }
    options.text.push(token);
  }
  return options;
}

function serializeTarget(target) {
  return {
    id: target.id,
    provider: target.provider,
    channel: target.channel,
    name: target.name,
    sessionId: target.sessionId || '',
    cwd: target.cwd || '',
    status: target.status || '',
    busy: target.busy === true,
    lastActivityAt: Number(target.lastActivityAt) || 0
  };
}

function serializeMessage(record) {
  return {
    id: record.id,
    shortId: shortMessageId(record.id),
    state: record.state,
    replyTo: record.replyTo || '',
    from: record.from || {},
    to: record.to || {},
    body: record.body || '',
    createdAt: Number(record.createdAt) || 0,
    deliveredAt: Number(record.deliveredAt) || 0,
    readAt: Number(record.readAt) || 0,
    // 历史发送/探测总数（旧版本曾把忙碌探测计入）；不是 v2 的真实失败次数。
    attempts: attemptCountOf(record),
    attemptCount: attemptCountOf(record),
    historicalAttemptCount: attemptCountOf(record),
    // 保守预算包含未保留的旧明细，不代表已观测到的真实发送失败次数。
    deliveryFailureCount: retryAttempts(record),
    subject: record.subject, summary: record.summary, purpose: record.purpose, action: record.action, replyPolicy: record.replyPolicy,
    autoDeliverUntil: autoDeliverUntilOf(record), expiresAt: Number(record.expiresAt) || 0,
    canceledAt: Number(record.canceledAt) || 0, supersedes: record.supersedes || '',
    notificationState: record.notificationState || '', waitingReason: record.waitingReason || '',
    // 目标级共享探测计数，不是本条消息的发送次数。
    busySince: Number(record.busySince) || 0, probeCount: Number(record.probeCount) || 0,
    nextAttemptAt: Number(record.nextAttemptAt) || 0, failureResetAt: Number(record.failureResetAt) || 0,
    error: record.error || ''
  };
}

function formatAge(at, now) {
  const delta = Math.max(0, now - (Number(at) || 0));
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`;
  return `${Math.round(delta / 86_400_000)}d`;
}

// 中文状态词占两个显示列，padEnd 只数 code unit——不按显示宽度补就会串列。
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text) {
  let width = 0;
  for (const char of String(text == null ? '' : text)) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  const value = String(text == null ? '' : text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatInboxRow(record, now) {
  const body = String(record.body || '').replace(/\s+/g, ' ').slice(0, 60);
  return [
    padDisplay(shortMessageId(record.id), 11),
    padDisplay(STATE_LABELS[record.notificationState] || STATE_LABELS[record.state] || record.state || '-', 8),
    padDisplay((record.from && record.from.name) || '-', 20),
    padDisplay((record.to && record.to.name) || '-', 20),
    padDisplay(formatAge(record.createdAt, now), 4),
    body
  ].join('  ');
}

function deliveryStatusNote(result) {
  if (result.notificationState === 'expired') return '内容已过期，原文保留，不会自动通知。';
  if (result.notificationState === 'canceled') return '通知已撤回，原文保留。';
  if (result.notificationState === 'manual' && result.reason === 'legacy_attempt_history_uncertain') {
    return '历史累计尝试（旧版可能含忙碌检查）的明细不完整，无法确认实际失败次数；已暂停自动通知，原文保留，确认后可显式重置重试预算。';
  }
  if (result.notificationState === 'manual') return '需要手动处理，自动通知已停止；确认仍需要后可用 resume 明确恢复。';
  const reasons = {
    target_busy: '对方正在工作', target_has_draft: '对方输入框已有草稿', target_cooldown: '上一条刚送达，等待对方处理',
    target_inflight: '已有通知正在投递', target_probe_unavailable: '暂时无法确认对方输入状态',
    target_input_unavailable: '暂时无法确认对方输入状态', target_state_unknown: '对方状态未知',
    native_send_failed: '传输失败，等待退避重试', chat_send_failed: '传输失败，等待退避重试',
    send_keys_failed: '传输失败，等待退避重试'
  };
  return `${reasons[result.reason] || '等待目标可接收'}；只在自动通知期内继续检查，不打断对方。`;
}

function countOpenByTarget(records) {
  const counts = new Map();
  for (const record of records) {
    const to = record.to || {};
    for (const key of [to.sessionId, to.name, to.address, to.id]) {
      const text = String(key || '').trim();
      if (!text) continue;
      counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  return counts;
}

async function runPeerCommand(argv = [], context = {}) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const write = (text) => stdout.write(`${text}\n`);
  const writeError = (text) => stderr.write(`${text}\n`);
  const options = parseArgs(argv);
  const peerService = context.peerService || defaultPeerService;
  const {
    normalizeChannel,
    listPeerTargets,
    sendPeerMessage,
    replyToMessage,
    listInbox,
    flushPending,
    formatPeerTarget
  } = peerService;
  // 注入的 peerService（测试/插件）可能只实现自己关心的动作：缺的用空实现兜底，
  // 别让一个未实现的动作变成 TypeError。
  const inboxOf = typeof listInbox === 'function' ? listInbox : () => [];
  const replyWith = typeof replyToMessage === 'function'
    ? replyToMessage
    : async () => ({ ok: false, error: 'reply_unsupported', message: '当前 peer 服务不支持回复。' });
  const flushWith = typeof flushPending === 'function'
    ? flushPending
    : async () => ({ attempted: 0, delivered: 0, pending: 0, failed: 0 });
  const listPeerChannels = peerService.listPeerChannels || (() => []);
  const listPeerCapabilities = peerService.listPeerCapabilities || (() => []);
  const resolveSelfIdentity = peerService.resolveSelfIdentity || (() => null);

  // --json 的错误也要是机器可读的：裸文本写到 stderr，脚本拿不到错误码。
  const fail = (error, message, extra = {}) => {
    const details = { ...extra };
    if (Array.isArray(details.candidates) && details.candidates.length === 0) delete details.candidates;
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: false, error, message, ...details }, null, 2)}\n`);
    } else {
      writeError(`\x1b[31m[aih]\x1b[0m ${message}`);
      for (const candidate of details.candidates || []) {
        writeError(`  ${candidate.shortId || candidate.id}  ${candidate.name || ''}`);
      }
    }
    return 1;
  };

  if (options.help) {
    printHelp(write);
    return 0;
  }
  const action = options.action || 'list';
  const channel = normalizeChannel(options.channel);
  if (options.channel && !channel) {
    return fail('unknown_channel', `未知通道：${options.channel}（native | inject | webui-chat）`);
  }

  const processImpl = context.processImpl || process;
  const env = context.env || processImpl.env || process.env;
  const hostHomeDir = context.hostHomeDir || resolvePeerHostHome(env);
  const aiHomeDir = context.aiHomeDir || resolvePeerAiHomeDir(env, hostHomeDir);
  const listOptions = {
    env,
    aiHomeDir,
    hostHomeDir,
    configDirs: context.configDirs || listClaudeConfigDirs(hostHomeDir, env),
    providers: context.providers,
    processImpl,
    channel,
    serverBaseUrl: context.serverBaseUrl,
    managementKey: context.managementKey,
    fs: context.fs,
    fetchImpl: context.fetchImpl,
    readServerConfig: context.readServerConfig,
    spawnSync: context.spawnSync,
    // 测试/嵌入方可以换掉通道实现；生产不传就是默认实现。
    createTmuxSessionAdapter: context.createTmuxSessionAdapter,
    createWebuiChatAdapter: context.createWebuiChatAdapter,
    listNativePeers: context.listNativePeers,
    sessionAdapter: context.sessionAdapter
  };
  const storeOptions = { aiHomeDir, fs: context.fs, now: context.now };
  const metadata = { subject: options.subject, summary: options.summary, purpose: options.purpose,
    action: options.actionMetadata, replyPolicy: options.replyPolicy, autoDeliverUntil: options.autoDeliverUntil,
    expiresAt: options.expiresAt, supersedes: options.supersedes };

  if (action === 'cancel' || action === 'resume') {
    if (!options.target) return fail('missing_message_id', '请选择要撤回或恢复通知的消息。');
    if (options.dryRun) return fail('unsupported_dry_run', '撤回/恢复不会投递消息；请明确执行本地状态变更。');
    const mutate = action === 'cancel' ? peerService.cancelPeerMessage : peerService.resumePeerMessage;
    if (typeof mutate !== 'function') return fail('mutation_unsupported', '当前 peer 服务不支持此操作。');
    const result = await mutate({ messageId: options.target, fromAddress: options.fromAddress,
      autoDeliverUntil: options.autoDeliverUntil, expiresAt: options.expiresAt, resetAttempts: options.resetAttempts }, { ...listOptions, ...storeOptions });
    if (!result.ok) return fail(result.error || 'mutation_failed', '无法修改通知：请确认发送方、消息身份与当前状态；已送达消息不能撤回。', { candidates: result.candidates || [] });
    if (options.json) stdout.write(`${JSON.stringify({ ok: true, message: serializeMessage(result.record) }, null, 2)}\n`);
    else write(action === 'cancel' ? '通知已撤回，原文仍保留。' : '已恢复通知意图；仍遵守目标等待与重试限制，不会立即打断对方。');
    return 0;
  }

  if (action === 'channels' || action === 'providers') {
    const rows = listPeerChannels();
    const capabilities = listPeerCapabilities();
    if (options.json) {
      stdout.write(`${JSON.stringify({ channels: rows, capabilities }, null, 2)}\n`);
      return 0;
    }
    write([`\x1b[90m${HARNESS_HEADER}\x1b[0m`,
      ...rows.map((row) => [
        String(row.provider || '').padEnd(12),
        String(row.channel || '').padEnd(10),
        String(row.label || '').padEnd(16),
        row.note || ''
      ].join('  '))].join('\n'));
    write('');
    write([`\x1b[90m${CAPABILITY_HEADER}\x1b[0m`,
      ...capabilities.map((row) => [
        String(row.channel || '').padEnd(13),
        String(row.delivery || '').padEnd(8),
        String(row.receive === true ? 'yes' : 'no').padEnd(7),
        row.note || ''
      ].join('  '))].join('\n'));
    return 0;
  }

  if (action === 'list' || action === 'ls') {
    const listing = await listPeerTargets(listOptions);
    const openMessages = inboxOf({ ...storeOptions, state: 'open', limit: 500 });
    const unread = countOpenByTarget(openMessages);
    if (options.json) {
      stdout.write(`${JSON.stringify({
        targets: listing.targets.map(serializeTarget),
        channels: listing.channels
      }, null, 2)}\n`);
      return 0;
    }
    if (!listing.targets.length) {
      write('没有可发消息的会话。先开一个（aih <provider>）或用 aih ss 看看有哪些。');
      return 0;
    }
    write([
      `\x1b[90m${TARGET_HEADER}\x1b[0m`,
      ...listing.targets.map((target) => formatPeerTarget(target, {
        unread: unread.get(target.sessionId) || unread.get(target.name) || unread.get(target.address) || 0
      }))
    ].join('\n'));
    return 0;
  }

  if (action === 'send') {
    const body = options.text.join(' ');
    if (!body.trim()) return fail('empty_text', '缺少正文：aih peer send <目标> "<正文>"');
    const result = await sendPeerMessage({
      ...metadata,
      target: options.target,
      text: body,
      channel: options.channel,
      provider: options.provider,
      mode: options.mode,
      fromAddress: options.fromAddress,
      replyTo: options.replyTo,
      dryRun: options.dryRun,
      noEnvelope: options.noEnvelope,
      wait: options.wait
    }, { ...listOptions, ...storeOptions, sessionAdapter: context.sessionAdapter });

    if (!result.ok) {
      return fail(result.error || 'send_failed', result.message || '发送失败', {
        candidates: result.candidates || []
      });
    }
    if (options.json) {
      stdout.write(`${JSON.stringify({
        ok: true,
        state: result.state,
        channel: result.channel,
        target: serializeTarget(result.target),
        messageId: result.messageId || '',
        shortId: result.shortId || '',
        queued: result.queued === true,
        notificationState: result.notificationState || '',
        reason: result.reason || '',
        dryRun: result.dryRun === true,
        commands: result.commands || undefined,
        ...(result.frames ? { frames: {
          auth: String(result.frames.auth || '').replace(/[0-9a-f]{32}/, '<peerToken>'),
          control: result.frames.control,
          message: result.frames.message
        } } : {})
      }, null, 2)}\n`);
      return 0;
    }
    if (result.dryRun) {
      if (result.channel === 'native' && result.frames) {
        // token 是凭据，预览里只留形状。
        stdout.write(result.frames.auth.replace(/[0-9a-f]{32}/, '<peerToken>'));
        stdout.write(result.frames.control);
      } else {
        write((result.commands || []).join('\n'));
      }
      return 0;
    }
    if (result.state === 'delivered') {
      write(`已投递 #${result.shortId} → ${result.target.name}（${result.channel}）`);
      return 0;
    }
    if (result.state === 'failed') {
      write(`#${result.shortId} 没有投出去：${result.reason}（aih peer inbox --state failed 可以补看）`);
      return 0;
    }
    write(`消息已保存 → ${result.target.name}：${deliveryStatusNote(result)}`);
    return 0;
  }

  if (action === 'inbox') {
    let target = options.target;
    if (options.self) {
      const self = resolveSelfIdentity({ env, spawnSync: context.spawnSync });
      if (!self) {
        return fail('self_unresolved', '不在 tmux 会话里，认不出「我是谁」；用 --target <名字> 指定。');
      }
      target = self.sessionId || self.name;
    }
    const records = inboxOf({
      ...storeOptions,
      state: options.unread ? 'unread' : (options.state || 'open'),
      target,
      limit: options.limit || 50
    });
    if (options.json) {
      stdout.write(`${JSON.stringify({
        messages: records.map(serializeMessage),
        target: target || ''
      }, null, 2)}\n`);
      return 0;
    }
    if (!records.length) {
      write(target ? `没有发给 ${target} 的待处理消息。` : '收件箱是空的。');
      return 0;
    }
    const now = Date.now();
    write([
      `\x1b[90m${INBOX_HEADER}\x1b[0m`,
      ...records.map((record) => formatInboxRow(record, now))
    ].join('\n'));
    write('');
    write('\x1b[90maih peer read <id>  看全文   ·   aih peer reply <id> "<正文>"  回一条\x1b[0m');
    return 0;
  }

  if (action === 'read') {
    if (!options.target) return fail('missing_message_id', '缺少消息 id：aih peer read <msg-id>');
    const store = createPeerStore(storeOptions);
    const found = store.findMessage(options.target);
    if (!found.record) {
      if (found.ambiguous.length) {
        return fail('ambiguous_message', `「${options.target}」匹配到多条消息：`, {
          candidates: found.ambiguous.map((record) => ({ id: record.id, shortId: shortMessageId(record.id) }))
        });
      }
      return fail('message_not_found', `找不到消息 ${options.target}。`);
    }
    const record = store.markRead(found.record.id) || found.record;
    const replies = store.listMessages({ state: 'all', limit: 500 })
      .filter((item) => item.replyTo === record.id);
    if (options.json) {
      stdout.write(`${JSON.stringify({
        message: serializeMessage(record),
        replies: replies.map(serializeMessage)
      }, null, 2)}\n`);
      return 0;
    }
    write(`\x1b[36m#${shortMessageId(record.id)}\x1b[0m  ${STATE_LABELS[record.state] || record.state}`);
    write(`from  ${(record.from && record.from.name) || '-'}   →   to  ${(record.to && record.to.name) || '-'}`);
    if (record.replyTo) write(`reply-to  ${shortMessageId(record.replyTo)}`);
    write('');
    write(readableMetadata(record));
    write('原文：');
    write(record.body || '');
    if (replies.length) {
      write('');
      write('\x1b[90m回复:\x1b[0m');
      for (const reply of replies) {
        write(`  #${shortMessageId(reply.id)} ${(reply.from && reply.from.name) || '-'}: ${reply.body}`);
      }
    }
    write('');
    write(`\x1b[90m回复: aih peer reply ${shortMessageId(record.id)} "<正文>"\x1b[0m`);
    return 0;
  }

  if (action === 'reply') {
    if (!options.target) return fail('missing_message_id', '缺少消息 id：aih peer reply <msg-id> "<正文>"');
    const body = options.text.join(' ');
    if (!body.trim()) return fail('empty_text', '缺少正文：aih peer reply <msg-id> "<正文>"');
    const result = await replyWith({
      ...metadata,
      messageId: options.target,
      text: body,
      dryRun: options.dryRun,
      noEnvelope: options.noEnvelope,
      fromAddress: options.fromAddress
    }, { ...listOptions, ...storeOptions });
    if (!result.ok) {
      return fail(result.error || 'reply_failed', result.message || '回复失败', {
        candidates: result.candidates || []
      });
    }
    if (options.json) {
      stdout.write(`${JSON.stringify({
        ok: true,
        state: result.state,
        channel: result.channel,
        target: serializeTarget(result.target),
        messageId: result.messageId || '',
        shortId: result.shortId || '',
        replyTo: result.replyTo || '',
        notificationState: result.notificationState || '', reason: result.reason || '',
        queued: result.queued === true
      }, null, 2)}\n`);
      return 0;
    }
    if (result.state === 'delivered') {
      write(`已回复 #${result.shortId} → ${result.target.name}（${result.channel}）`);
      return 0;
    }
    write(`回复已保存 → ${result.target.name}：${deliveryStatusNote(result)}`);
    return 0;
  }

  if (action === 'flush') {
    // 显式 CLI 在本进程观察安静期；后台 flushPending 仍保留单次探测默认。
    const requestedWaitMs = options.wait == null ? 3_000 : options.wait * 1_000;
    const timeoutMs = Number.isFinite(requestedWaitMs) ? Math.max(0, requestedWaitMs) : 3_000;
    const summary = await flushWith({
      ...listOptions,
      ...storeOptions,
      sessionAdapter: context.sessionAdapter,
      timeoutMs
    });
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
      return 0;
    }
    write(`通知检查：目标检查 ${summary.probed || 0} 次，实际发送 ${summary.attempted} 次，送达 ${summary.delivered}，等待 ${summary.pending}，需处理 ${summary.failed + (summary.manual || 0)}。`);
    return 0;
  }

  return fail('unknown_action', `未知动作：${action}\n  ${USAGE}`);
}

module.exports = {
  parseArgs,
  runPeerCommand,
  formatInboxRow,
  serializeTarget,
  serializeMessage
};
