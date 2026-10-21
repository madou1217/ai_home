'use strict';

// 宿主配置文件里「权限已经放开」的判定：注入启动参数前先看一眼，已经满足就不再加。
//
// 为什么需要（2026-10-21 用户报障）：
//   `aih codex` 每次启动都注入 `--sandbox danger-full-access --ask-for-approval never`，
//   而用户的 `~/.codex/config.toml` 里本来就写着 `sandbox_mode = "danger-full-access"`。
//   命令行与配置表达同一件事，却让 codex 的界面显示与用户自己 `/approvals` 切出来的状态
//   对不上；resume 路径又会把命令行旗标摘掉（上游拒绝远程任务的权限覆盖），于是同一个
//   provider 在「新会话 / 恢复会话」下显示两种权限状态。
//
// 判定规则：把命令行要注入的那组参数，与配置文件里当前生效的值逐项比对；
// **全部等价**才算「已经满足」，跳过注入。部分满足（比如配置只有 sandbox、没有
// approval）不算 —— 那种情况注入是必要的补全，不是重复。
//
// 只读：这里绝不改写宿主配置。写配置是另一条明确动作（permission-host-config）。

const nodeFs = require('node:fs');
const { resolvePermissionProfile } = require('./permission-profiles');
const { readConfigFile } = require('../cli/services/toolkit/provider-config-manager');

const jsonc = require('jsonc-parser');

/** 顶层 TOML 键的取值（只认 `key = value`，值与权限参数比对用字符串）。 */
function readTomlTopLevelValue(content, key) {
  const matcher = new RegExp(`^\\s*${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = String(content == null ? '' : content).match(matcher);
  if (!match) return undefined;
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  return raw;
}

/** JSON/JSONC 的点路径取值。 */
function readJsonPathValue(content, path) {
  const source = String(content == null ? '' : content).trim();
  if (!source) return undefined;
  const errors = [];
  return jsonc.parse(source, errors, { allowTrailingComma: true, disallowComments: false })[path.split('.')[0]] === undefined
    ? undefined
    : path.split('.').reduce((current, segment) => (
      current && typeof current === 'object' ? current[segment] : undefined
    ), jsonc.parse(source, errors, { allowTrailingComma: true, disallowComments: false }));
}

function readConfigValue(content, format, key) {
  return String(format || '').toLowerCase() === 'toml'
    ? readTomlTopLevelValue(content, key)
    : readJsonPathValue(content, key);
}

function sameValue(a, b) {
  return String(a === undefined || a === null ? '' : a).trim() === String(b === undefined || b === null ? '' : b).trim();
}

/**
 * 命令行参数 → 配置文件键值的对照表（声明式，不按 provider 名分支）。
 *
 * 每条规则声明「哪个旗标、带几个值、对应配置里的哪些键」；新增 provider 只加一行，
 * 逻辑代码不认 provider 名（项目铁律：新代码走声明 + 注册表，见 design-pattern-guard）。
 * 只登记「同一件事的两种表达都已知」的组合；未登记的旗标不参与判定。
 */
const ARGV_CONFIG_RULES = Object.freeze({
  codex: Object.freeze([
    Object.freeze({ flag: '--sandbox', aliases: Object.freeze(['-s']), keys: Object.freeze(['sandbox_mode']) }),
    Object.freeze({ flag: '--ask-for-approval', aliases: Object.freeze(['-a']), keys: Object.freeze(['approval_policy']) })
  ]),
  claude: Object.freeze([
    Object.freeze({ flag: '--permission-mode', keys: Object.freeze(['permissions.defaultMode']) })
  ])
});

function rulesFor(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return Array.isArray(ARGV_CONFIG_RULES[provider]) ? ARGV_CONFIG_RULES[provider] : [];
}

/** 该 provider 的对照规则里是否出现过这个旗标（含别名）。 */
function findArgvRule(providerRaw, flag) {
  const name = String(flag || '').trim();
  if (!name) return null;
  return rulesFor(providerRaw).find((rule) => rule.flag === name
    || (Array.isArray(rule.aliases) && rule.aliases.includes(name))) || null;
}

/**
 * 命令行参数 → 配置文件里对应的键值对。
 * 只处理已登记对照关系的 provider；未登记的返回空数组（调用方据此跳过判定）。
 */
function argvToConfigPairs(provider, argv) {
  const args = (Array.isArray(argv) ? argv : []).map((value) => String(value || '').trim()).filter(Boolean);
  const pairs = [];
  for (let index = 0; index < args.length; index += 1) {
    const rule = findArgvRule(provider, args[index]);
    if (!rule) continue;
    const value = args[index + 1];
    if (!value || String(value).startsWith('-')) continue;
    index += 1;
    for (const key of rule.keys) pairs.push([key, value]);
  }
  return pairs;
}

/**
 * 配置文件是否已经表达了这组启动参数的全部含义。
 *
 * @returns {{ satisfied: boolean, reason: string, checked: Array<{key: string, expected: string, actual: string}> }}
 *   satisfied=true 时调用方应跳过注入（配置已经放开，不必再用命令行重复一遍）。
 */
function isHostPermissionSatisfied(provider, argv, options = {}) {
  const profile = resolvePermissionProfile(provider);
  const empty = { satisfied: false, reason: 'no_config_target', checked: [] };
  if (!profile.hostSupported || !profile.hostFileId) return empty;
  const pairs = argvToConfigPairs(profile.provider, argv);
  if (pairs.length === 0) return { satisfied: false, reason: 'no_comparable_args', checked: [] };

  let detail;
  try {
    detail = readConfigFile(profile.provider, profile.hostFileId, {
      fs: options.fs || nodeFs,
      home: options.home,
      hostHomeDir: options.hostHomeDir,
      env: options.env,
      path: options.path
    });
  } catch (_error) {
    return { satisfied: false, reason: 'config_unreadable', checked: [] };
  }
  const content = detail && detail.content;
  const format = detail && detail.file && detail.file.format;
  if (content === undefined || content === null) return { satisfied: false, reason: 'config_missing', checked: [] };

  const checked = pairs.map(([key, expected]) => ({ key, expected, actual: readConfigValue(content, format, key) }));
  const satisfied = checked.every((item) => sameValue(item.actual, item.expected));
  return {
    satisfied,
    reason: satisfied ? 'host_config_already_grants' : 'host_config_differs',
    checked
  };
}

/**
 * 配置文件已经表达了这组启动参数里的**哪些**含义。
 *
 * 与 `isHostPermissionSatisfied` 的差别：那个要求全部等价才算满足，这个逐项报告，
 * 让调用方只补配置缺的部分 —— 「配置里已经有的就不要再加，也不要替用户加宽」。
 *
 * @returns {{ known: boolean, reason: string, items: Array<{key: string, expected: string, actual: string, matched: boolean}> }}
 */
function readHostPermissionState(provider, argv, options = {}) {
  const profile = resolvePermissionProfile(provider);
  if (!profile.hostSupported || !profile.hostFileId) {
    return { known: false, reason: 'no_config_target', items: [] };
  }
  // 必须显式给出宿主 home 才读配置：不传就退回进程 HOME 会让「读的是谁的配置」变得隐式，
  // 测试里换个临时 aiHome 却仍然读到真实宿主配置（实测把注入整个抑制掉了）。
  if (!String(options.home || options.hostHomeDir || '').trim()) {
    return { known: false, reason: 'host_home_not_provided', items: [] };
  }
  const pairs = argvToConfigPairs(profile.provider, argv);
  if (pairs.length === 0) return { known: false, reason: 'no_comparable_args', items: [] };

  let detail;
  try {
    detail = readConfigFile(profile.provider, profile.hostFileId, {
      fs: options.fs || nodeFs,
      home: options.home,
      hostHomeDir: options.hostHomeDir,
      env: options.env,
      path: options.path
    });
  } catch (_error) {
    return { known: false, reason: 'config_unreadable', items: [] };
  }
  const content = detail && detail.content;
  if (content === undefined || content === null) return { known: false, reason: 'config_missing', items: [] };
  const format = detail && detail.file && detail.file.format;
  const items = pairs.map(([key, expected]) => {
    const actual = readConfigValue(content, format, key);
    return { key, expected, actual, matched: sameValue(actual, expected) };
  });
  return { known: true, reason: 'read', items };
}

/**
 * 从待注入参数里剔除「宿主配置已经表达」的项，只留需要补的。
 * 参数的键值对无法与配置项对应时原样保留（宁可多注入，也不静默丢掉权限）。
 */
function dropHostSatisfiedArgs(provider, argv, hostState) {
  const args = (Array.isArray(argv) ? argv : []).map((value) => String(value || '').trim()).filter(Boolean);
  const satisfiedKeys = new Set(
    (hostState && Array.isArray(hostState.items) ? hostState.items : [])
      .filter((item) => item.matched)
      .map((item) => item.key)
  );
  if (satisfiedKeys.size === 0) return args;
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const hasValue = Boolean(value) && !String(value).startsWith('-');
    const pairs = hasValue ? argvToConfigPairs(provider, [flag, value]) : [];
    // 这一对（旗标+值）对应的配置键都已满足 → 整对丢掉；否则原样保留。
    if (pairs.length > 0 && pairs.every(([key]) => satisfiedKeys.has(key))) {
      index += 1;
      continue;
    }
    kept.push(flag);
    if (hasValue) {
      kept.push(value);
      index += 1;
    }
  }
  return kept;
}

module.exports = {
  argvToConfigPairs,
  dropHostSatisfiedArgs,
  isHostPermissionSatisfied,
  readConfigValue,
  readHostPermissionState
};
