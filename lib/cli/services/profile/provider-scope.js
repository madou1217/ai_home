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
 *   - 没有元字符时先全名精确匹配（`aih codebuddy ls` 永远只解析出一个 provider），
 *     精确不到再按**子串**匹配（`aih buddy ls` = 四个 buddy）；
 *   - 一个都没匹配上就是错误，不静默退化成全量列表 —— 打错字却看到全部账号最难查。
 *
 * 为什么要子串这一档：zsh 在 aih 启动**之前**就展开了 `*buddy*`，没有同名文件时直接
 * `no matches found`，命令根本执行不到。让不带通配符的名字也模糊匹配，用户就不用为了
 * 一次查询去记"要加单引号"。通配符仍然保留（引号内），两者语义一致。
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

// 单字符子串会命中半个 provider 表（`aih a ls`），那不像"过滤"更像手滑；
// 两字符起（`cn`、`buddy`）才是有意义的模糊查询。
const MIN_SUBSTRING_LENGTH = 2;

/**
 * 用户写的"provider 选择器"→ 命中的 provider 列表。优先级：
 *   1. 含 `*`/`?` → 按通配符匹配（语义严格，匹配不到就是没匹配到）；
 *   2. 全名精确（大小写不敏感）；
 *   3. 子串（≥2 字符），解决 zsh 提前展开通配符的问题。
 */
function matchProviderSelector(token, providers = []) {
  const normalized = normalizeProviderName(token);
  if (!normalized) return [];
  const pool = (Array.isArray(providers) ? providers : [])
    .map((provider) => String(provider == null ? '' : provider))
    .filter(Boolean);
  if (isProviderPattern(normalized)) return matchProviderPattern(normalized, pool);

  const exact = matchProviderPattern(normalized, pool);
  if (exact.length > 0) return exact;
  if (normalized.length < MIN_SUBSTRING_LENGTH) return [];
  return pool.filter((provider) => normalizeProviderName(provider).includes(normalized));
}

/**
 * 多个 selector 取并集。顺序按出现顺序，重复项只留一次。
 * unmatched 单独返回，调用方决定是报错还是忽略（`provider ls` 也用它）。
 */
function resolveProviderScope(patterns, providers = []) {
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  (Array.isArray(patterns) ? patterns : []).forEach((pattern) => {
    const token = String(pattern == null ? '' : pattern).trim();
    if (!token) return;
    const hits = matchProviderSelector(token, providers);
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
 * 通配符没命中时给一条"能直接敲"的建议。
 * `buddy*`（前缀）在这套 provider 名里一个都不中，用户想说的多半是 `*buddy*`——
 * 而 zsh 会先展开 `*`，所以建议里给**不带通配符**的子串写法（`buddy`），
 * 复制回去就能用，不必再加引号。
 * 只提示不改行为：静默放宽匹配会让 `aih buddy* ls` 的结果无法预期。
 */
function suggestProviderSelector(pattern, providers = []) {
  const core = normalizeProviderName(pattern).replace(/[*?]/g, '').trim();
  if (core.length < MIN_SUBSTRING_LENGTH) return null;
  const hits = matchProviderSelector(core, providers);
  if (hits.length === 0) return null;
  return { selector: core, providers: hits };
}

/** 报错文案：既说清没匹配上什么，也把可选值摆出来，省一次 `--help`。 */
function describeScopeMiss(unmatched, providers = []) {
  const list = Array.isArray(unmatched) ? unmatched : [];
  const missing = list.map((item) => `"${item}"`).join(', ');
  const known = (Array.isArray(providers) ? providers : []).join(', ');
  let message = `[aih] No provider matches ${missing}. Known providers: ${known}`;
  const hints = list
    .map((item) => suggestProviderSelector(item, providers))
    .filter(Boolean);
  if (hints.length === 1) {
    // 建议里故意不带 *：zsh 会在 aih 之前展开它，复制回去就是一条报错。
    message += `\n       Did you mean "${hints[0].selector}" (no quotes or wildcards needed)? It matches ${hints[0].providers.join(', ')}.`;
  }
  return message;
}

module.exports = {
  isProviderPattern,
  compileProviderPattern,
  matchProviderPattern,
  matchProviderSelector,
  resolveProviderScope,
  parseProviderScopeArgs,
  suggestProviderSelector,
  describeScopeMiss
};
