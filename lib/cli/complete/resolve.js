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
  listProviderNames
} = require('./command-tree');
const { getProviderMenuLabel } = require('../../provider-catalog');
const { listHistoryRemainders } = require('./history');

// 这些动作后面接的是**账号 id**，因此可以给账号候选；其余动作接的是会话 id 或原生参数，一律不猜。
const ACCOUNT_POSITION_ACTIONS = new Set(['usage', 'home', 'delete', 'deleteall', 'set-default', 'set-mobile']);

const ESCAPE_HATCH = Object.freeze({
  value: '--',
  description: '逃生门：之后的参数原样交给原生 CLI'
});

function matchesPrefix(value, current) {
  if (!current) return true;
  if (value.startsWith(current)) return true;
  return value.toLowerCase().startsWith(current.toLowerCase());
}

/** 候选分组：zsh 侧按组分别 compadd（每组一个标题），bash 侧忽略。 */
const GROUPS = Object.freeze({
  COMMAND: '命令',
  PROVIDER: 'CLI',
  ACTION: '动作',
  SUBCOMMAND: '子命令',
  ACCOUNT: '账号',
  FLAG: '选项',
  HISTORY: '历史（你用过）',
  OTHER: '其它'
});

function createCollector(current) {
  const items = [];
  const seen = new Set();
  return {
    items,
    add(value, description, group = GROUPS.OTHER) {
      const text = String(value == null ? '' : value);
      if (!text || seen.has(text)) return;
      if (!matchesPrefix(text, current)) return;
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

function addAccounts(collector, context, provider) {
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
      addAccounts(collector, context, head);
      for (const flag of listProviderActionFlags(action)) collector.add(flag, '选项', GROUPS.FLAG);
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
  for (const flag of node.flags || []) collector.add(flag, '选项', GROUPS.FLAG);
  return collector.items;
}

module.exports = {
  ACCOUNT_POSITION_ACTIONS,
  ESCAPE_HATCH,
  GROUPS,
  addAccounts,
  addHistoryCandidates,
  addSessionFlags,
  addTopLevelCommands,
  createCollector,
  describeProvider,
  matchesPrefix,
  resolveCompletion
};
