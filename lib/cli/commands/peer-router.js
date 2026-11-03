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
//   aih peer flush

const {
  resolvePeerHostHome,
  resolvePeerAiHomeDir,
  listClaudeConfigDirs
} = require('../services/peer/scope');
// 允许注入：路由只做参数解析与展示，测试不需要真的连 tmux / claude / server。
const defaultPeerService = require('../services/peer');
const { createPeerStore, shortMessageId, attemptCountOf } = require('../services/peer/store');

const USAGE = [
  'aih peer [list] [--json] [--provider <p>] [--channel <c>]',
  'aih peer channels                # 每条通道怎么投递（能力表）',
  'aih peer send <名字|id|pid|会话id> "<正文>" [--reply-to <msg-id>] [--wait <秒>] [--from <地址>] [--dry-run] [--json]',
  'aih peer inbox [--target <名字|id>] [--self] [--unread] [--limit <n>] [--json]',
  'aih peer read <msg-id> [--json]',
  'aih peer reply <msg-id> "<正文>" [--dry-run] [--json]',
  'aih peer flush [--json]          # 手动补投一轮待投递消息'
].join('\n  ');

const STATE_LABELS = Object.freeze({
  pending: '待投递',
  delivered: '已送达',
  read: '已读',
  failed: '失败'
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
    '  消息先落盘到收件箱（run/peer），再立刻投一次；对方忙或不可达就排队，',
    '  由 aih server 的空闲推送补投。aih peer inbox 随时可以补看。',
    '',
    '\x1b[90m例子:\x1b[0m',
    '  aih peer                                    # 看看能发给谁',
    '  aih peer send ai-home-fc "跑一下 test"       # claude 会话（native）',
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
    help: false
  };
  const valueFlags = new Set([
    '--provider', '--channel', '--mode', '--from',
    '--target', '--reply-to', '--limit', '--wait', '--state'
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
  };
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === '--help' || token === '-h' || token === 'help') { options.help = true; continue; }
    if (token === '--json') { options.json = true; continue; }
    if (token === '--dry-run') { options.dryRun = true; continue; }
    if (token === '--self') { options.self = true; continue; }
    if (token === '--unread') { options.unread = true; continue; }
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
    // 总尝试次数（`attempts` 明细有截断上限，不能拿数组长度当次数）。
    attempts: attemptCountOf(record),
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
    padDisplay(STATE_LABELS[record.state] || record.state || '-', 8),
    padDisplay((record.from && record.from.name) || '-', 20),
    padDisplay((record.to && record.to.name) || '-', 20),
    padDisplay(formatAge(record.createdAt, now), 4),
    body
  ].join('  ');
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
  const storeOptions = { aiHomeDir, fs: context.fs };

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
    const body = options.text.join(' ').trim();
    if (!body) return fail('empty_text', '缺少正文：aih peer send <目标> "<正文>"');
    const result = await sendPeerMessage({
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
    write(`已入队 #${result.shortId} → ${result.target.name}（${result.channel}）：${result.reason || '目标忙'}`);
    write('目标空闲后由 aih server 自动投递；也可以 aih peer flush 手动补投。');
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
    const body = options.text.join(' ').trim();
    if (!body) return fail('empty_text', '缺少正文：aih peer reply <msg-id> "<正文>"');
    const result = await replyWith({
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
        queued: result.queued === true
      }, null, 2)}\n`);
      return 0;
    }
    if (result.state === 'delivered') {
      write(`已回复 #${result.shortId} → ${result.target.name}（${result.channel}）`);
      return 0;
    }
    write(`已入队回复 #${result.shortId} → ${result.target.name}：${result.reason || '目标忙'}`);
    return 0;
  }

  if (action === 'flush') {
    const summary = await flushWith({
      ...listOptions,
      ...storeOptions,
      sessionAdapter: context.sessionAdapter
    });
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: true, ...summary }, null, 2)}\n`);
      return 0;
    }
    write(`补投：尝试 ${summary.attempted} 条，送达 ${summary.delivered}，仍待投 ${summary.pending}，失败 ${summary.failed}。`);
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
