'use strict';

/**
 * Provider 作用域：把「provider 位里的通配符」和 `--scope` 列表解析成具体名单。
 *
 * 为什么要它：provider 只会越加越多（buddy 系现在就有 codebuddy / codebuddycn /
 * workbuddy / workbuddycn 四个），记全名不现实；只想看几个同类 provider 的账号时，
 * 也不该敲四遍 `aih <cli> ls`。
 *
 * 匹配规则刻意收窄，避免"猜"：
 *   - 只有 `*`（任意长度，含空串）和 `?`（单个字符）两个元字符，大小写不敏感；
 *   - 没有元字符时按全名精确匹配（`aih codebuddy ls` 永远只解析出一个 provider）；
 *   - 一个都没匹配上就是错误，不静默退化成全量列表 —— 打错字却看到全部账号最难查。
 */

const WILDCARD_PATTERN = /[*?]/;
const SCOPE_FLAG = '--scope';

function normalizeProviderName(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function isProviderPattern(token) {
  return WILDCARD_PATTERN.test(String(token == null ? '' : token));
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*buddy*` / `buddy*` / `*buddy` / `code?uddy` → 锚定到整个 provider 名的正则。 */
function compileProviderPattern(pattern) {
  const source = normalizeProviderName(pattern)
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return escapeRegExp(char);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** 返回 pool 里被 pattern 命中的 provider（保留 pool 里的原始大小写与顺序）。 */
function matchProviderPattern(pattern, providers = []) {
  const token = normalizeProviderName(pattern);
  if (!token) return [];
  const pool = (Array.isArray(providers) ? providers : [])
    .map((provider) => String(provider == null ? '' : provider))
    .filter(Boolean);
  if (!isProviderPattern(token)) {
    return pool.filter((provider) => normalizeProviderName(provider) === token);
  }
  const matcher = compileProviderPattern(token);
  return pool.filter((provider) => matcher.test(normalizeProviderName(provider)));
}

/**
 * 多个 pattern 取并集。顺序按 pattern 出现顺序，重复项只留一次。
 * unmatched 单独返回，调用方决定是报错还是忽略（`provider ls` 也用它）。
 */
function resolveProviderScope(patterns, providers = []) {
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const token = String(pattern == null ? '' : pattern).trim();
    if (!token) return;
    const hits = matchProviderPattern(token, providers);
    if (hits.length === 0) {
      unmatched.push(token);
      return;
    }
    hits.forEach((hit) => {
      if (seen.has(hit)) return;
      seen.add(hit);
      matched.push(hit);
    });
  });
  return { providers: matched, unmatched };
}

function splitScopeValue(value) {
  return String(value == null ? '' : value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 从参数里摘出 `--scope`：
 *   `--scope a b` / `--scope=a,b` / 多个 `--scope` 累加。
 * 取值到下一个选项为止；纯数字 token 留给位置参数（账号 id），provider 名不会全是数字。
 */
function parseProviderScopeArgs(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  const patterns = [];
  const rest = [];
  let used = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] == null ? '' : tokens[index]);
    if (token === SCOPE_FLAG) {
      used = true;
      index += 1;
      while (index < tokens.length) {
        const value = String(tokens[index]);
        if (value.startsWith('-') || /^\d+$/.test(value)) break;
        patterns.push(...splitScopeValue(value));
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (token.startsWith(`${SCOPE_FLAG}=`)) {
      used = true;
      patterns.push(...splitScopeValue(token.slice(SCOPE_FLAG.length + 1)));
      continue;
    }
    rest.push(tokens[index]);
  }
  return { patterns, rest, used };
}

/**
 * 打错通配符时给一条"更宽松的写法"建议。
 * `buddy*`（前缀）在这套 provider 名里一个都不中，但用户想说的多半是 `*buddy*`；
 * 只提示不改行为——静默放宽匹配会让 `aih buddy* ls` 的结果无法预期。
 */
function suggestProviderPattern(pattern, providers = []) {
  const core = normalizeProviderName(pattern).replace(/[*?]/g, '').trim();
  if (!core) return null;
  const loose = `*${core}*`;
  const hits = matchProviderPattern(loose, providers);
  if (hits.length === 0) return null;
  return { pattern: loose, providers: hits };
}

/** 报错文案：既说清没匹配上什么，也把可选值摆出来，省一次 `--help`。 */
function describeScopeMiss(unmatched, providers = []) {
  const list = Array.isArray(unmatched) ? unmatched : [];
  const missing = list.map((item) => `"${item}"`).join(', ');
  const known = (Array.isArray(providers) ? providers : []).join(', ');
  let message = `[aih] No provider matches ${missing}. Known providers: ${known}`;
  const hints = list
    .map((item) => suggestProviderPattern(item, providers))
    .filter(Boolean);
  if (hints.length === 1) {
    message += `\n       Did you mean "${hints[0].pattern}"? It matches ${hints[0].providers.join(', ')}.`;
  }
  return message;
}

module.exports = {
  isProviderPattern,
  compileProviderPattern,
  matchProviderPattern,
  resolveProviderScope,
  parseProviderScopeArgs,
  suggestProviderPattern,
  describeScopeMiss
};
