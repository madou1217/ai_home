'use strict';

// 认证来源解析器 —— 把描述符里声明的来源，结合宿主机能力，归一成「现在能用哪些来源」。
//
// 为什么需要它：同一个认证方式可能有多个来源（例如 kiro 的 refresh_token 既能从本机 Kiro IDE
// 登录态读、也能让用户粘贴；设备码则只有远程一条路）。**界面与任务链路都不该自己判断**
// 「这台机器上有没有 IDE / 装了没 / 能不能装」，它们只消费这里的结果。
//
// 排序语义与 models / quota 的策略链一致：
//   ① 可用优先 → ② 不依赖客户端优先 → ③ id 稳定序（结果确定，便于测试与 UI 稳定）。

const { createHostCapabilities } = require('../runtime/host-capabilities');

// 排序语义与 models / quota 的策略链**刻意相反**：
//   ① 可用优先 → ② **本机来源优先**（能直接读到的登录态对用户最省事）→ ③ id 稳定序。
// 采集链路偏好「不依赖客户端」（更稳、更少受本机影响）；账号获取偏好「用户不用动手」。
// 两者意图不同，不要为了统一而统一——统一会让 UI 在装了 IDE 的机器上仍然先推设备码。

function compareAuthSources(left, right) {
  return (Number(right.available) - Number(left.available))
    || (Number(right.clientDependent) - Number(left.clientDependent))
    || left.id.localeCompare(right.id);
}

/** 调用来源自报的探针/指纹：探针失败一律当成「不可用/无指纹」，绝不因为探针抛错而中断整条解析。 */
function safeCall(fn, deps) {
  try {
    return fn(deps || {});
  } catch (_error) {
    return null;
  }
}

function describeSource(source, { provider, host, existingIdentities, deps }) {
  const requiresApp = source.requires && source.requires.app ? source.requires.app : '';
  // 可用性优先用来源自报的探针（本机来源 = 凭据读得到）；没有探针时回落到「客户端装没装」。
  const appAvailable = typeof source.available === 'function'
    ? Boolean(safeCall(source.available, deps))
    : (requiresApp ? host.appAvailable(provider, requiresApp) : true);
  const installable = !appAvailable && requiresApp ? host.canInstall(provider, requiresApp) : false;
  // 已入库去重：本机登录态的指纹命中账号池 → 不再作为可导入来源（用户要求「已存在就不显示」）。
  let alreadyImported = false;
  if (appAvailable && typeof source.identity === 'function' && existingIdentities instanceof Set) {
    const identity = String(safeCall(source.identity, deps) || '').trim();
    alreadyImported = Boolean(identity) && existingIdentities.has(identity);
  }
  const available = appAvailable && !alreadyImported;
  const reason = available
    ? ''
    : (alreadyImported ? 'account_already_registered'
      : (installable ? 'client_not_installed' : (requiresApp ? 'client_unavailable' : 'unavailable')));
  return {
    id: source.id,
    kind: source.kind,
    clientDependent: source.clientDependent,
    requiresApp,
    authMode: source.authMode || '',
    handler: source.handler || '',
    // 能否不经登录任务直接提交：来源实现若已把完整投影写进 runtime dir（宿主登录态物化即如此），
    // 调用方可以直接注册账号；需要身份核验/换 token 的来源（如 kiro IDE）必须走登录任务，
    // 由任务链路完成 finalize。声明在来源里，调用方不按 provider 名判断。
    directImport: Boolean(source.directImport),
    description: source.description || '',
    available,
    installable,
    alreadyImported,
    reason,
    // 不可用的来源不给出实现：调用方拿不到「不该用」的东西。
    implementation: available && typeof source.import === 'function' ? source.import : null
  };
}

/** 账号池里该 provider 已入库账号的指纹集合（与来源级 identity 同源）。 */
function collectProviderAuthIdentities(provider, options = {}) {
  const capability = options.capability && typeof options.capability.accountIdentity === 'function'
    ? options.capability
    : (options.providers || require('../providers')).getProviderCapability(provider, 'authSources', options);
  const identities = new Set();
  if (!capability || typeof capability.accountIdentity !== 'function') return identities;
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return identities;
  let records = [];
  try {
    records = require('../server/account-credential-store').listAccountCredentialRecords(fs, aiHomeDir, provider);
  } catch (_error) {
    return identities;
  }
  for (const record of records) {
    try {
      const identity = String(capability.accountIdentity(record && record.nativeAuth) || '').trim();
      if (identity) identities.add(identity);
    } catch (_error) {
      // 单条记录算不出指纹不影响其它账号的去重判断。
    }
  }
  return identities;
}

/**
 * 解析某 provider 在当前宿主机上的认证来源。
 *
 * @returns {{supported: boolean, provider: string, sources: Array<object>}}
 */
function resolveAuthSources(provider, options = {}) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const { getProviderCapability } = options.providers || require('../providers');
  const capability = typeof options.capability === 'object' && options.capability
    ? options.capability
    : getProviderCapability(normalizedProvider, 'authSources', options);
  if (!capability || !capability.supported) {
    return { supported: false, provider: normalizedProvider, sources: [] };
  }
  const host = options.hostCapabilities || createHostCapabilities(options.hostCapabilitiesOptions || {});
  const deps = {
    fs: options.fs,
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostCapabilitiesOptions && options.hostCapabilitiesOptions.hostHomeDir,
    env: options.env,
    ...(options.deps || {})
  };
  // 已入库指纹：默认从账号池收集（调用方可用 existingIdentities 显式覆盖，
  // 或 collectExistingIdentities:false 关掉——例如只想看「本机有没有登录态」的场景）。
  const existingIdentities = options.existingIdentities instanceof Set
    ? options.existingIdentities
    : (options.collectExistingIdentities === false
      ? null
      : collectProviderAuthIdentities(normalizedProvider, { ...options, capability }));
  const sources = capability.sources
    .map((source) => describeSource(source, { provider: normalizedProvider, host, existingIdentities, deps }))
    .sort(compareAuthSources);
  return { supported: true, provider: normalizedProvider, sources };
}

/** 取某个认证方式下当前最合适的来源（可用优先，其次本机来源）。 */
function pickAuthSource(resolved, authMode) {
  const mode = String(authMode || '').trim();
  const candidates = (resolved && Array.isArray(resolved.sources) ? resolved.sources : [])
    .filter((source) => source.authMode === mode);
  return candidates.find((source) => source.available) || candidates[0] || null;
}

/** 给 UI 的精简视图：每个认证方式一行，附「是否有本机来源可用 / 可安装」。 */
function describeAuthMethodsWithSources(provider, options = {}) {
  const resolved = resolveAuthSources(provider, options);
  if (!resolved.supported) return { supported: false, provider: resolved.provider, methods: [] };
  const byMode = new Map();
  for (const source of resolved.sources) {
    if (!source.authMode) continue;
    const current = byMode.get(source.authMode) || { authMode: source.authMode, sources: [] };
    current.sources.push(source);
    byMode.set(source.authMode, current);
  }
  const methods = [...byMode.values()].map((entry) => {
    const usable = entry.sources.find((source) => source.available) || null;
    // 可安装来源**独立于兜底**：即使当前有粘贴这条兜底，UI 也该提示「装了 Kiro IDE 就能一键导入」。
    const installable = entry.sources.find((source) => source.installable) || null;
    return {
      authMode: entry.authMode,
      sources: entry.sources,
      preferredSourceId: usable ? usable.id : '',
      installableSourceId: installable ? installable.id : '',
      localSourceAvailable: entry.sources.some((source) => source.kind === 'local' && source.available)
    };
  });
  return { supported: true, provider: resolved.provider, methods };
}

module.exports = {
  collectProviderAuthIdentities,
  compareAuthSources,
  describeAuthMethodsWithSources,
  pickAuthSource,
  resolveAuthSources
};
