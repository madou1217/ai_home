'use strict';

// 通用「从本机导入」——把**宿主客户端自己写的登录态**物化成本账号的投影，再交给既有注册链路。
//
// 与 kiro 的 IDE 导入同一条思路，但**不针对某个 provider 写死**：
//   * 宿主路径与运行时路径都来自 lib/runtime/provider-storage-policy.js 的 authArtifacts
//     （artifact.path 相对家目录，正是 CLI/IDE 自己放凭据的位置）；
//   * 去重指纹两侧同源：都用 lib/account/account-identity.js 的 identitySeed
//     （对 token 轮换免疫——它来自凭据里的身份字段，而不是会变的 token 字节）。
//
// 描述符里这样声明（一行）：authSources: createHostAuthSources('claude', { app: 'cli' })

const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { PROVIDER_STORAGE_POLICIES } = require('../runtime/provider-storage-policy');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/** 该 provider 的宿主凭据产物（相对家目录的路径；optional 的缺失不算失败）。 */
function hostAuthArtifacts(provider) {
  const policy = PROVIDER_STORAGE_POLICIES[normalizeProvider(provider)];
  const artifacts = policy && Array.isArray(policy.authArtifacts) ? policy.authArtifacts : [];
  return artifacts
    .map((artifact) => ({
      field: String(artifact.field || ''),
      relative: Array.isArray(artifact.path) ? artifact.path : [],
      optional: Boolean(artifact.optional)
    }))
    .filter((artifact) => artifact.relative.length > 0);
}

function resolveHostHome(options = {}) {
  const explicit = String(options.hostHomeDir || '').trim();
  if (explicit) return explicit;
  return resolveHostHomeDir({ env: options.env, platform: options.platform });
}

/** 宿主登录态是否可读（只看必选产物；返回可读到的文件清单）。 */
function readHostAuthState(provider, options = {}) {
  const fs = options.fs || require('node:fs');
  const hostHomeDir = resolveHostHome(options);
  if (!hostHomeDir) return { ok: false, reason: 'host_home_unavailable' };
  const artifacts = hostAuthArtifacts(provider);
  if (artifacts.length === 0) return { ok: false, reason: 'provider_has_no_host_artifact' };
  const found = [];
  for (const artifact of artifacts) {
    const file = nodePath.join(hostHomeDir, ...artifact.relative);
    if (fs.existsSync(file)) {
      found.push({ ...artifact, file });
      continue;
    }
    if (!artifact.optional) return { ok: false, reason: 'host_login_state_missing', missing: artifact.relative.join('/') };
  }
  if (found.length === 0) return { ok: false, reason: 'host_login_state_missing' };
  return { ok: true, hostHomeDir, artifacts: found };
}

/**
 * 宿主登录态的**去重指纹**：与账号侧同源（都用 identitySeed），对 token 轮换免疫。
 * 读不出来（degraded）时返回 ''，调用方据此不做去重判断（宁可显示也不误判）。
 */
function hostAuthIdentity(provider, options = {}) {
  const fs = options.fs || require('node:fs');
  const state = readHostAuthState(provider, options);
  if (!state.ok) return '';
  const projection = { auth: null };
  try {
    const primary = state.artifacts[0];
    const parsed = JSON.parse(fs.readFileSync(primary.file, 'utf8'));
    projection.auth = parsed && typeof parsed === 'object' ? parsed : null;
    if (primary.field) projection[primary.field] = parsed;
  } catch (_error) {
    return '';
  }
  const resolved = resolveNativeAuthIdentitySeed(normalizeProvider(provider), projection);
  return resolved && !resolved.degraded && resolved.identitySeed ? resolved.identitySeed : '';
}

/** 账号侧指纹（capability.accountIdentity 用）：与宿主侧同一函数。 */
function accountAuthIdentity(provider) {
  return (nativeAuth) => {
    const resolved = resolveNativeAuthIdentitySeed(normalizeProvider(provider), nativeAuth);
    return resolved && !resolved.degraded && resolved.identitySeed ? resolved.identitySeed : '';
  };
}

/** 把宿主登录态复制进目标 runtime dir（0600）。 */
function materializeHostAuthIntoRuntime(provider, options = {}) {
  const fs = options.fs || require('node:fs');
  const runtimeDir = String(options.runtimeDir || '').trim();
  if (!runtimeDir) return { ok: false, reason: 'runtime_dir_missing' };
  const state = readHostAuthState(provider, options);
  if (!state.ok) return state;
  const written = [];
  try {
    for (const artifact of state.artifacts) {
      const target = nodePath.join(runtimeDir, ...artifact.relative);
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      fs.copyFileSync(artifact.file, target);
      fs.chmodSync(target, 0o600);
      written.push(artifact.relative.join('/'));
    }
  } catch (error) {
    return { ok: false, reason: `host_auth_copy_failed:${(error && error.message) || 'unknown'}` };
  }
  return { ok: true, written };
}

/** 认证来源工厂：deps → { id, import(options) }（与 kiro 的工厂同形）。 */
function createHostAuthImportSource(provider, deps = {}) {
  const normalized = normalizeProvider(provider);
  return {
    id: `${normalized}-host-local`,
    import: async (options = {}) => {
      const materialized = materializeHostAuthIntoRuntime(normalized, { ...deps, ...options });
      if (!materialized.ok) return { ok: false, reason: materialized.reason };
      // 投影已就位；身份核验与账号注册由既有 finalizeJob → registerProviderAuthProjection 完成。
      return { ok: true, source: `${normalized}-host`, written: materialized.written };
    }
  };
}

/**
 * 描述符里的一行声明：宿主登录态 → 一个本机来源（+ 账号侧指纹）。
 * @returns {{ supported: true, accountIdentity: Function, sources: Array<object> }}
 */
function createHostAuthSources(provider, options = {}) {
  const normalized = normalizeProvider(provider);
  const app = String(options.app || 'cli').trim() || 'cli';
  return {
    supported: true,
    accountIdentity: accountAuthIdentity(normalized),
    sources: [
      {
        id: `${normalized}-host-local`,
        kind: 'local',
        clientDependent: true,
        requires: { app },
        authMode: String(options.authMode || 'oauth-browser'),
        // 宿主登录态是**完整投影**：物化完就能注册，不需要登录任务的身份核验/换 token 阶段。
        directImport: true,
        import: (deps) => createHostAuthImportSource(normalized, deps),
        identity: (deps) => hostAuthIdentity(normalized, deps || {}),
        // 可用性 = 宿主凭据读得到（而不是二进制装没装）。
        available: (deps) => readHostAuthState(normalized, deps || {}).ok,
        description: String(options.description
          || `读取本机 ${normalized} 客户端的登录态并直接入库，不需要用户手动导出`)
      }
    ]
  };
}

module.exports = {
  accountAuthIdentity,
  createHostAuthImportSource,
  createHostAuthSources,
  hostAuthArtifacts,
  hostAuthIdentity,
  materializeHostAuthIntoRuntime,
  readHostAuthState
};
