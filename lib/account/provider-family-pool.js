'use strict';

// CodeBuddy 家族里**可以互换启动凭据**的 CLI 成员。
//
// 家族四支共享同一套会话存储（runtime/codebuddy-family-session-store.js），
// 但只有 codebuddy / codebuddycn 这一对由同一个 npm 包提供同一个二进制
// （@tencent-ai/codebuddy-code），差别只在站点环境与配置根。workbuddy 两支是
// 桌面端构建，不保证有可直接启动的 CLI，因此不放进原生换号的目标池。
//
// 注意：这里只说「换号目标可以是谁」，不改变账号归属。账号仍属于它自己的
// provider；换号时用目标 provider 的投影目录启动，会话 id 因为共享存储而继续有效。

const CLI_SWITCH_POOLS = Object.freeze({
  codebuddy: Object.freeze(['codebuddy', 'codebuddycn']),
  codebuddycn: Object.freeze(['codebuddy', 'codebuddycn'])
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/** 当前 CLI 可以切换到的 provider 列表（含自己，自己永远排第一）。 */
function listSwitchableProviders(provider) {
  const normalized = normalizeProvider(provider);
  if (!normalized) return [];
  const pool = CLI_SWITCH_POOLS[normalized];
  if (!pool) return [normalized];
  return [normalized, ...pool.filter((entry) => entry !== normalized)];
}

function isSwitchableProvider(baseProvider, targetProvider) {
  const base = normalizeProvider(baseProvider);
  const target = normalizeProvider(targetProvider);
  if (!base || !target) return false;
  if (base === target) return true;
  return listSwitchableProviders(base).includes(target);
}

/**
 * 解析 `provider:id` / `provider/id` / 纯数字 / accountRef 形式的换号目标。
 * 纯数字的 provider 归属由调用方用账号表解析（同一数字在两家可能都存在）。
 */
function parseSwitchTarget(token) {
  const text = String(token == null ? '' : token).trim();
  if (!text) return null;
  const qualified = /^([a-z][a-z0-9-]*)[:/](\d+)$/i.exec(text);
  if (qualified) {
    return { provider: qualified[1].toLowerCase(), cliAccountId: qualified[2], accountRef: '' };
  }
  if (/^\d+$/.test(text)) return { provider: '', cliAccountId: text, accountRef: '' };
  if (/^acct_[a-f0-9]{20}$/.test(text)) return { provider: '', cliAccountId: '', accountRef: text };
  return null;
}

/**
 * 换号目标的可读标签。跨 provider 时带 provider 前缀（`codebuddycn:2`），
 * 同 provider 保持纯数字（既有 `1→2` 的观感不变）。
 */
function formatSwitchTarget(target, baseProvider = '') {
  if (!target) return '';
  const cliAccountId = String(target.cliAccountId || '').trim();
  const accountRef = String(target.accountRef || '').trim();
  const provider = normalizeProvider(target.provider);
  const base = normalizeProvider(baseProvider);
  if (cliAccountId) {
    return provider && provider !== base ? `${provider}:${cliAccountId}` : cliAccountId;
  }
  return accountRef;
}

module.exports = {
  CLI_SWITCH_POOLS,
  formatSwitchTarget,
  isSwitchableProvider,
  listSwitchableProviders,
  parseSwitchTarget
};
