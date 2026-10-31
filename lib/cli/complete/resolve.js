'use strict';

/**
 * 补全解析：把「已经敲下的词」映射成候选（值 + 一句说明）。
 *
 * 纯函数（历史、账号列表由调用方注入），这样补全逻辑可被 `aih shell` 与调试入口复用，
 * 也不会在热路径上悄悄做 IO。
 *
 * 位置规则（刻意保守）：
 * - 第 1 位：aih 顶层命令 + 所有 CLI provider + 历史里跑过的整条命令。
 * - provider 的第 2 位：该 provider 的动作 + 账号 id + `--` 逃生门。
 * - provider 的账号位之后：只给 aih 自己的持久会话旗标与 `--`，**不猜原生参数**。
 * - 顶层命令的下钻：只查 `NESTED_SUBCOMMAND_TABLES`；表里没有的层级返回空，
 *   让 shell 用它自己的默认补全。
 */

const {
  AIH_SESSION_FLAGS,
  NESTED_SUBCOMMAND_TABLES,
  TOP_LEVEL_COMMANDS,
  findTopLevelCommand,
  isProviderName,
  listProviderActionFlags,
  listProviderActions,
  listProviderNames,
  supportsAihServerProfile
} = require('./command-tree');
const { getProviderMenuLabel } = require('../../provider-catalog');
const { listHistoryRemainders } = require('./history');
const { listProviderSessions, listServerConfigFlags, listServerConfigValues } = require('./candidates');
const { AIH_SERVER_PROFILE_ID } = require('../../account/provider-profile-id');

// 这些动作后面接的是**账号 id**，因此可以给账号候选；其余动作接的是会话 id 或原生参数，一律不猜。
const ACCOUNT_POSITION_ACTIONS = new Set(['usage', 'home', 'delete', 'deleteall', 'set-default', 'set-mobile']);

// 这些动作后面接的是**会话 id**（provider 自己的会话库），给会话候选而不是账号候选。
const SESSION_POSITION_ACTIONS = new Set(['resume', 'fork', 'sessions']);

const ESCAPE_HATCH = Object.freeze({
  value: '--',
  description: '逃生门：之后的参数原样交给原生 CLI'
});

function matchesPrefix(value, current) {
  if (!current) return true;
  if (value.startsWith(current)) return true;
  return value.toLowerCase().startsWith(current.toLowerCase());
}

/**
 * 会话候选的"按标题命中"：id 是 UUID，没人记得住；允许用标题里的任意片段过滤
 * （`aih codex resume 复制` 能直接落到标题含"复制"的那一段）。
 * 值仍然是 id，所以补全完直接回车就能续聊。
 */
function matchesContains(text, current) {
  if (!current) return true;
  const haystack = String(text || '').toLowerCase();
  return haystack.includes(String(current).toLowerCase());
}

/** 候选分组：zsh 侧按组分别 compadd（每组一个标题），bash 侧忽略。 */
const GROUPS = Object.freeze({
  COMMAND: '命令',
  PROVIDER: 'CLI',
  ACTION: '动作',
  SUBCOMMAND: '子命令',
  ACCOUNT: '账号',
  SESSION: '会话',
  FLAG: '选项',
  HISTORY: '历史（你用过）',
  OTHER: '其它'
});

function createCollector(current) {
  const items = [];
  const seen = new Set();
  return {
    items,
    add(value, description, group = GROUPS.OTHER, matchText = '') {
      const text = String(value == null ? '' : value);
      if (!text || seen.has(text)) return;
      if (!matchesPrefix(text, current) && !matchesContains(matchText, current)) return;
      seen.add(text);
      items.push({ value: text, description: String(description || ''), group: String(group || '') });
    }
  };
}

function describeProvider(provider) {
  const label = String(getProviderMenuLabel(provider) || '').trim();
  return label ? `CLI：${label}` : 'CLI';
}

function shortRef(accountRef) {
  const text = String(accountRef || '');
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

/** 历史候选：候选值是「历史里当前还没敲的那一段」，多词候选一次插完整行（和 fish 一致）。 */
function addHistoryCandidates(collector, context, current, priorText = '') {
  const entries = Array.isArray(context.historyEntries) ? context.historyEntries : [];
  if (!entries.length) return;
  const limit = Number(context.historyLimit) || 8;
  for (const entry of listHistoryRemainders(entries, priorText, { prefix: current, limit })) {
    collector.add(entry.suffix, `用过 ${entry.count} 次`, GROUPS.HISTORY);
  }
}

function addSessionFlags(collector) {
  for (const flag of AIH_SESSION_FLAGS) collector.add(flag.name, flag.summary, GROUPS.FLAG);
  collector.add(ESCAPE_HATCH.value, ESCAPE_HATCH.description, GROUPS.OTHER);
}

function addAccounts(collector, context, provider, options = {}) {
  if (typeof context.listAccounts !== 'function') return;
  let accounts = [];
  try {
    accounts = context.listAccounts(provider) || [];
  } catch (_error) {
    accounts = [];
  }
  for (const account of accounts) {
    const id = String((account && account.cliAccountId) || '').trim();
    if (!id) continue;
    collector.add(id, `账号 ${shortRef(account && account.accountRef)}`, GROUPS.ACCOUNT);
  }
  // `set-default` 还接受网关档位本身，但只有声明了 gateway_profile 的 provider 才有这一档。
  if (options.includeAihServerProfile && context.aihServerProfileId) {
    collector.add(String(context.aihServerProfileId), 'AIH Server（内置网关档）', GROUPS.ACCOUNT);
  }
}

/** 相对时间：pane 的 created 是秒，这里是给人看的「N 分钟前 / N 天前」。 */
function formatRelativeMoment(value) {
  const numeric = Number(value) || 0;
  if (!numeric) return '';
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 会话时间可能是 ISO 串或 epoch 毫秒，统一压成 `YYYY-MM-DD HH:mm`（看不出来就原样）。 */
function formatSessionTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // 读出来的时间戳可能是 1793450430038.65 这种带小数的毫秒，也可能是 10 位秒。
  if (/^\d{9,16}(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    const ms = numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
  }
  return text.slice(0, 16);
}

/** 会话 id 候选：`aih <cli> resume|fork <TAB>`（aih 活跃会话优先，然后是原生历史）。 */
function addSessionIds(collector, context, provider, accountToken = '', current = '') {
  if (typeof context.listSessions !== 'function') return;
  // 账号位存在时把 accountRef 带上：这样才能读到 aih 服务端的持久会话注册表，
  // 给「正在跑的会话」加标记并排到最前。
  let accountRef = '';
  const token = String(accountToken || '').trim();
  if (token && typeof context.listAccounts === 'function') {
    try {
      const accounts = context.listAccounts(provider) || [];
      const match = accounts.find((account) => String(account && account.cliAccountId) === token
        || String(account && account.accountRef) === token);
      if (match) accountRef = String(match.accountRef || '');
    } catch (_error) { /* 无账号上下文：只给历史 */ }
  }
  let sessions = [];
  try {
    sessions = context.listSessions(provider, accountRef, current) || [];
  } catch (_error) {
    sessions = [];
  }
  for (const session of sessions) {
    const id = String((session && session.id) || '').trim();
    if (!id) continue;
    const title = String((session && session.title) || '').trim();
    const when = formatSessionTime(session && session.updatedAt);
    const live = session && session.live ? '● 活跃' : '';
    // 注释里**必须有标题**（没有标题就写占位），再跟时间——否则补全列表全是 UUID，没法选。
    const detail = [live, title || '(无标题)', when].filter(Boolean).join(' · ');
    collector.add(id, detail, GROUPS.SESSION, title);
  }
}

/** 顶层命令（含别名）→ 候选。 */
function addTopLevelCommands(collector) {
  for (const command of TOP_LEVEL_COMMANDS) {
    collector.add(command.name, command.summary, GROUPS.COMMAND);
    for (const alias of command.aliases || []) collector.add(alias, command.summary, GROUPS.COMMAND);
  }
  for (const provider of listProviderNames()) {
    collector.add(provider, describeProvider(provider), GROUPS.PROVIDER);
  }
}

function resolveCompletion(words, context = {}) {
  const tokens = (Array.isArray(words) ? words : []).map((token) => String(token == null ? '' : token));
  const current = tokens.length ? tokens[tokens.length - 1] : '';
  const prior = tokens.slice(0, Math.max(0, tokens.length - 1));
  const collector = createCollector(current);

  // `--` 之后是原生 CLI 的世界：一律不给候选。
  if (prior.includes('--')) return [];

  if (!prior.length) {
    addTopLevelCommands(collector);
    addHistoryCandidates(collector, context, current);
    return collector.items;
  }

  const head = prior[0];
  const lastPrior = prior[prior.length - 1];

  // 选项的值位：这几个键的取值是枚举，不该让用户去记。
  //   --provider <TAB>  → 所有 CLI provider
  //   --account  <TAB>  → 该 provider 的账号 id（就近找 --provider）
  if (lastPrior === '--provider') {
    for (const provider of listProviderNames()) collector.add(provider, describeProvider(provider), GROUPS.PROVIDER);
    return collector.items;
  }
  if (lastPrior === '--account') {
    // 就近找 provider：先看 --provider 的值，再看命令行里已经出现的 provider 词
    // （`aih claim zcode --account <TAB>` 这种没有 --provider 的写法）。
    const providerIndex = prior.lastIndexOf('--provider');
    let provider = providerIndex >= 0 ? String(prior[providerIndex + 1] || '').trim().toLowerCase() : '';
    if (!isProviderName(provider)) {
      for (let index = prior.length - 1; index >= 0; index -= 1) {
        if (isProviderName(prior[index])) { provider = String(prior[index]).toLowerCase(); break; }
      }
    }
    if (isProviderName(provider)) {
      addAccounts(collector, context, provider);
      return collector.items;
    }
  }

  if (isProviderName(head)) {
    if (prior.length === 1) {
      for (const action of listProviderActions(head)) {
        collector.add(action.name, action.summary, GROUPS.ACTION);
      }
      addAccounts(collector, context, head);
      collector.add(ESCAPE_HATCH.value, ESCAPE_HATCH.description, GROUPS.OTHER);
      addHistoryCandidates(collector, context, current, head);
      return collector.items;
    }
    const action = prior[1];
    if (ACCOUNT_POSITION_ACTIONS.has(action) && prior.length === 2) {
      addAccounts(collector, context, head, {
        includeAihServerProfile: action === 'set-default' && supportsAihServerProfile(head)
      });
      for (const flag of listProviderActionFlags(action)) collector.add(flag, '选项', GROUPS.FLAG);
      return collector.items;
    }
    if (SESSION_POSITION_ACTIONS.has(action) && prior.length === 2) {
      addSessionIds(collector, context, head, '', current);
      for (const flag of listProviderActionFlags(action)) collector.add(flag, '选项', GROUPS.FLAG);
      return collector.items;
    }
    // 账号位之后：仍然给动作，而不是只给一堆旗标——"aih codex 2 <TAB>" 应该能直接
    // 补出 resume / sessions / delete …，这是最常见的输入顺序。
    if (prior.length === 2 && (/^\d+$/.test(action) || /^acct_[a-f0-9]{20}$/.test(action))) {
      for (const next of listProviderActions(head)) {
        collector.add(next.name, next.summary, GROUPS.ACTION);
      }
      collector.add(ESCAPE_HATCH.value, ESCAPE_HATCH.description, GROUPS.OTHER);
      return collector.items;
    }
    // `aih <cli> <账号> resume|fork <TAB>`：账号位之后仍然是会话 id。
    if (prior.length === 3 && SESSION_POSITION_ACTIONS.has(prior[2]) && !String(prior[1]).startsWith('-')) {
      addSessionIds(collector, context, head, prior[1], current);
      return collector.items;
    }
    if (prior.length === 2) {
      for (const flag of listProviderActionFlags(action)) collector.add(flag, '选项', GROUPS.FLAG);
    }
    addSessionFlags(collector);
    return collector.items;
  }

  const node = findTopLevelCommand(head);
  if (!node) return [];

  if (prior.length === 1) {
    // aih ss <TAB>：本机正在跑的持久会话名（pane 名），选中直接进入。
    if ((node.name === 'ss' || node.name === 'sessions') && typeof context.listPersistentSessions === 'function') {
      let rows = [];
      try { rows = context.listPersistentSessions(current) || []; } catch (_error) { rows = []; }
      for (const row of rows) {
        const name = String((row && row.name) || '').trim();
        if (!name) continue;
        // 注释顺序：位置 → 标题（最重要，不然只剩一串 pane 名）→ provider → 多久前 → 状态。
        const detail = [
          row.here ? '◆ 当前目录' : '',
          String(row.title || '').trim(),
          String(row.provider || '').trim(),
          formatRelativeMoment(row.createdAt),
          row.live ? '● 运行中' : ''
        ].filter(Boolean).join(' · ');
        collector.add(name, detail, GROUPS.SESSION, `${row.title || ''} ${row.description || ''}`.trim());
      }
      for (const sub of node.subcommands || []) collector.add(sub.name, sub.summary, GROUPS.SUBCOMMAND);
      return collector.items;
    }
    // aih resume <TAB>：选择器的候选就是最近的会话本身（选中回车即可续聊）。
    if (node.name === 'resume' && typeof context.listResumeSessions === 'function') {
      let recent = [];
      try { recent = context.listResumeSessions(current) || []; } catch (_error) { recent = []; }
      for (const session of recent) {
        const title = String((session && session.title) || '').trim();
        const when = formatSessionTime(session && session.updatedAt);
        const detail = [title || '(无标题)', String((session && session.provider) || ''), when].filter(Boolean).join(' · ');
        collector.add(String(session && session.id || ''), detail, GROUPS.SESSION, title);
      }
      return collector.items;
    }
    // 文件参数命令：把补全交回 shell（文件路径），不列旗标。
    if (node.name === 'export' || node.name === 'import') return collector.items;
    for (const sub of node.subcommands || []) collector.add(sub.name, sub.summary, GROUPS.SUBCOMMAND);
    for (const flag of node.flags || []) collector.add(flag, '选项', GROUPS.FLAG);
    if (!(node.subcommands || []).length) collector.add('--help', '打印用法', GROUPS.FLAG);
    return collector.items;
  }

  const nestedKey = [node.name, ...prior.slice(1)].join(' ');
  const nested = NESTED_SUBCOMMAND_TABLES[nestedKey];
  if (nested) {
    for (const name of nested) collector.add(name, '', GROUPS.SUBCOMMAND);
    for (const flag of node.flags || []) collector.add(flag, '选项', GROUPS.FLAG);
    return collector.items;
  }
  // `aih server config set|get --<TAB>`：选项直接来自 server config 的唯一描述符表，
  // 因此补全列表和 `aih server config list` / `--help` 永远同源。
  if (node.name === 'server' && prior[1] === 'config' && prior.length >= 3
    && (prior[2] === 'set' || prior[2] === 'get')) {
    // 已经在某个旗标之后：给它的合法取值（枚举字段），没取值就回到旗标列表。
    if (prior[2] === 'set' && lastPrior.startsWith('--')) {
      const values = listServerConfigValues(lastPrior);
      if (values.length > 0) {
        for (const value of values) collector.add(value.value, value.description, GROUPS.FLAG);
        return collector.items;
      }
    }
    for (const flag of listServerConfigFlags()) collector.add(flag.value, flag.description, GROUPS.FLAG);
    return collector.items;
  }
  // 只收文件/路径参数的命令：不返回候选，交回 shell 的文件补全。
  if (node.name === 'export' || node.name === 'import') return collector.items;
  for (const flag of node.flags || []) collector.add(flag, '选项', GROUPS.FLAG);
  return collector.items;
}

module.exports = {
  ACCOUNT_POSITION_ACTIONS,
  ESCAPE_HATCH,
  GROUPS,
  SESSION_POSITION_ACTIONS,
  addAccounts,
  addHistoryCandidates,
  addSessionFlags,
  addSessionIds,
  addTopLevelCommands,
  createCollector,
  describeProvider,
  formatSessionTime,
  matchesPrefix,
  resolveCompletion
};
