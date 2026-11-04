'use strict';

/**
 * `aih ls` 的参数规划：把命令词之后的 token 解析成「列谁、列哪个账号」。
 *
 * 三种写法在这里收敛成同一个 plan，后续只有一条执行路径：
 *   aih ls                          全量
 *   aih <provider> ls [id]          单个 provider（精确名）
 *   aih '*buddy*' ls [id]           provider 位通配
 *   aih ls --scope codebuddy workbuddy
 *
 * 轻量入口（ls-fastpath）与完整 CLI（root router）都走这里，避免两份解析各自漂移。
 */

const {
  isProviderPattern,
  matchProviderPattern,
  resolveProviderScope,
  parseProviderScopeArgs,
  describeScopeMiss
} = require('./provider-scope');

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

function normalizeProviderList(providers) {
  return providers.map((provider) => String(provider).trim().toLowerCase());
}

function usageFor(providers, pattern) {
  if (pattern) return `aih '${pattern}' ls [id] [--scope <provider...>]`;
  if (providers && providers.length === 1) return `aih ${providers[0]} ls [id]`;
  return 'aih ls [id] [--scope <provider...>]';
}

/**
 * @param {string[]} tokens 命令词起头的 token（`['ls', …]` 或 `['*buddy*', 'ls', …]`）
 * @param {{providerNames?: string[], isSupportedCli?: (name: string) => boolean}} options
 * @returns {{action:'none'}|{action:'help', scope: string|null}|{action:'error', message: string}
 *   |{action:'list', providers: string[]|null, filterId: string|null, pattern: string|null}}
 */
function resolveLsRequest(tokens, options = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const providerNames = Array.isArray(options.providerNames) ? options.providerNames : [];
  const isSupportedCli = typeof options.isSupportedCli === 'function'
    ? options.isSupportedCli
    : (name) => matchProviderPattern(name, providerNames).length === 1;

  const head = String(list[0] || '').trim();
  if (!head) return { action: 'none' };

  let providers = null;
  let pattern = null;
  let tail = null;
  if (head === 'ls') {
    tail = list.slice(1);
  } else if (String(list[1] || '').trim() === 'ls') {
    if (isSupportedCli(head)) {
      providers = normalizeProviderList([head]);
      tail = list.slice(2);
    } else if (isProviderPattern(head)) {
      const matched = matchProviderPattern(head, providerNames);
      // 通配符一个都没命中：这里必须报错。放行的话会退化成"全量列表"，
      // 用户以为自己过滤了，实际看到的是所有账号。
      if (matched.length === 0) {
        return { action: 'error', message: describeScopeMiss([head], providerNames) };
      }
      providers = normalizeProviderList(matched);
      pattern = head;
      tail = list.slice(2);
    }
  }
  if (!tail) return { action: 'none' };

  const { patterns, rest, used } = parseProviderScopeArgs(tail);
  if (HELP_TOKENS.has(String(rest[0] || '').trim())) {
    return { action: 'help', scope: providers && providers.length === 1 ? providers[0] : null };
  }
  if (used && patterns.length === 0) {
    return { action: 'error', message: '[aih] --scope needs at least one provider (e.g. --scope codebuddy workbuddy).' };
  }
  if (patterns.length > 0) {
    const resolved = resolveProviderScope(patterns, providerNames);
    if (resolved.unmatched.length > 0) {
      return { action: 'error', message: describeScopeMiss(resolved.unmatched, providerNames) };
    }
    const scoped = normalizeProviderList(resolved.providers);
    providers = providers
      ? providers.filter((provider) => scoped.includes(provider))
      : scoped;
    if (providers.length === 0) {
      return {
        action: 'error',
        message: `[aih] --scope ${patterns.join(' ')} does not overlap ${pattern || 'the given provider'}.`
      };
    }
  }

  const idArg = String(rest[0] || '').trim();
  let filterId = null;
  if (providers) {
    if (idArg && !/^\d+$/.test(idArg)) {
      return {
        action: 'error',
        message: `[aih] Invalid ID. Usage: ${usageFor(providers, pattern)}`
      };
    }
    filterId = idArg || null;
  }
  return { action: 'list', providers, filterId, pattern };
}

module.exports = {
  resolveLsRequest
};
