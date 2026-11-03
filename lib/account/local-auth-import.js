'use strict';

// 从**本机登录态**直接建账号（不走登录任务）。
//
// 为什么需要它：登录任务通道是给「需要跟用户交互或跟上游换 token」的流程用的（设备码、浏览器回调、
// 粘贴 refresh_token）。但有些 provider 的本机登录态本身就是**完整投影**——宿主 CLI 已经把凭据写成了
// 目标格式（opencode 的 `auth.json` 就是这种），此时开一个任务只为了复制一个文件是多余的，而且
// 这些 provider 的认证方式（api-key）根本不经过登录任务，界面也就没有承载入口。
//
// 边界：本模块只做「解析来源 → 物化进新账号 runtime dir → 走既有注册链路」三件事。
//   * 环境判断（这台机器上来源可不可用）交给认证来源链（lib/account/auth-sources.js）；
//   * 账号身份/指纹/入库交给既有 registerProviderAuthProjection；
//   * 需要身份核验或换 token 的来源声明 directImport=false，这里明确拒绝（由登录任务链路处理），
//     **不按 provider 名判断**。

const path = require('path');
const crypto = require('crypto');

const { resolveAuthSources } = require('./auth-sources');
const { registerProviderAuthProjection } = require('./native-auth-projection');
const { resolveLoginRuntimeDir } = require('../runtime/aih-storage-layout');

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/**
 * 按来源 id 从本机登录态建账号。
 * @returns {Promise<{ok:true, accountRef:string, cliAccountId:any, sourceId:string, runtimeDir:string}
 *   | {ok:false, code:string, source?:object}>}
 */
async function importLocalAuthSource(options = {}) {
  const fs = options.fs || require('node:fs');
  const provider = normalizeProvider(options.provider);
  if (!provider) return { ok: false, code: 'missing_provider' };
  const requested = String(options.sourceId || '').trim();
  if (!requested) return { ok: false, code: 'missing_source_id' };

  const deps = {
    fs,
    hostHomeDir: options.hostHomeDir,
    request: options.request
  };
  const resolved = options.resolved || resolveAuthSources(provider, {
    fs,
    aiHomeDir: options.aiHomeDir,
    hostCapabilitiesOptions: { hostHomeDir: options.hostHomeDir }
  });
  const source = (resolved.sources || []).find((item) => item.id === requested) || null;
  if (!source) return { ok: false, code: 'auth_source_unknown' };
  // 已在账号池里：界面本就不显示该入口，这里再兜一层，绝不建重复账号。
  if (source.alreadyImported) return { ok: false, code: 'auth_source_already_imported', source };
  if (!source.available) return { ok: false, code: `auth_source_unavailable:${source.reason}`, source };
  if (typeof source.implementation !== 'function') return { ok: false, code: 'auth_source_impl_missing', source };
  if (!source.directImport) return { ok: false, code: 'auth_source_requires_login_job', source };

  const aiHomeDir = options.aiHomeDir;
  const sessionId = `local-${crypto.randomBytes(6).toString('hex')}`;
  const runtimeDir = resolveLoginRuntimeDir(aiHomeDir, provider, sessionId);
  if (!runtimeDir) return { ok: false, code: 'invalid_login_runtime' };
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (error) {
    return { ok: false, code: `login_runtime_unwritable:${(error && error.message) || 'unknown'}` };
  }

  const importOptions = { ...deps, runtimeDir };
  let result;
  try {
    const implementation = source.implementation(importOptions);
    result = await implementation.import(importOptions);
  } catch (error) {
    return { ok: false, code: (error && error.code) || 'local_auth_import_failed', source };
  }
  if (!result || !result.ok) {
    return { ok: false, code: (result && result.reason) || 'local_auth_import_failed', source };
  }

  let registration;
  try {
    registration = registerProviderAuthProjection(fs, runtimeDir, provider, { path, aiHomeDir });
  } catch (error) {
    return { ok: false, code: 'local_auth_register_failed', detail: (error && error.message) || '', source };
  }
  if (!registration || !registration.registered) {
    return {
      ok: false,
      code: `local_auth_register_failed:${(registration && registration.reason) || 'unknown'}`,
      source
    };
  }
  return {
    ok: true,
    accountRef: registration.accountRef,
    cliAccountId: registration.cliAccountId,
    sourceId: source.id,
    runtimeDir
  };
}

module.exports = { importLocalAuthSource };
