'use strict';

// 宿主登录态的**扫描入库**（WebUI「扫描本机账号」/ `aih <cli> detect` / 后台观察共用）。
//
// 与「从本机导入」（local-auth-import.js）同一条物化链路：宿主产物 → 临时登录 runtime dir →
// registerProviderAuthProjection（身份去重走 identitySeed）。区别只在**写入语义**：
//   * 扫描是自动观察，不是用户显式登记：`respectDeletion`（墓碑）+ `insertOnly`（库里已有同身份
//     账号一律不动——宿主那份与库内那份谁更新比不出来，比不出来就不动库）；
//   * 自写回流守卫（host-self-write-guard.js）：aih 自己写到宿主的网关配置不能被扫回来；
//   * 损坏文件只跳过本 provider 并给出原因，调用方继续扫其它 provider。

const nodePath = require('node:path');
const crypto = require('node:crypto');

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

function readArtifactText(fs, file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return { reason: 'host_credential_file_unsupported' };
  if (stat.size > MAX_ARTIFACT_BYTES) return { reason: 'host_credential_file_too_large' };
  return { text: fs.readFileSync(file, 'utf8') };
}

/** 逐个宿主产物过守卫：路径落在 aih 私有目录 / 带 aih 签名 / JSON 损坏 → 返回原因码。 */
function inspectHostArtifacts(fs, artifacts, guard) {
  for (const artifact of artifacts) {
    const pathReason = guard ? guard.rejectsPath(artifact.file) : '';
    if (pathReason) return pathReason;
    let read;
    try {
      read = readArtifactText(fs, artifact.file);
    } catch (_error) {
      return 'host_credential_file_unreadable';
    }
    if (read.reason) return read.reason;
    if (/\.json$/iu.test(artifact.file)) {
      try {
        JSON.parse(read.text);
      } catch (_error) {
        return 'host_credential_file_corrupt';
      }
    }
    const textReason = guard ? guard.rejectsText(read.text) : '';
    if (textReason) return textReason;
  }
  return '';
}

/**
 * 扫描一个 provider 的宿主登录态并（仅在是新账号时）入库。
 *
 * @returns {{status: 'absent'|'skipped'|'unchanged'|'registered', reason: string,
 *   provider: string, accountRef?: string, cliAccountId?: string, created?: boolean}}
 */
function scanHostAuthProjection(provider, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const normalized = String(provider || '').trim().toLowerCase();
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const { readHostAuthState, materializeHostAuthIntoRuntime } = require('./host-auth-import');
  const state = readHostAuthState(normalized, deps);
  if (!state.ok) return { status: 'absent', reason: state.reason, provider: normalized };
  if (!aiHomeDir) return { status: 'skipped', reason: 'ai_home_dir_missing', provider: normalized };

  const guardReason = inspectHostArtifacts(fs, state.artifacts, deps.guard);
  if (guardReason) return { status: 'skipped', reason: guardReason, provider: normalized };

  const { resolveLoginRuntimeDir } = require('../runtime/aih-storage-layout');
  const runtimeDir = resolveLoginRuntimeDir(aiHomeDir, normalized, `scan-${crypto.randomBytes(6).toString('hex')}`);
  if (!runtimeDir) return { status: 'skipped', reason: 'invalid_login_runtime', provider: normalized };
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const materialized = materializeHostAuthIntoRuntime(normalized, { ...deps, fs, runtimeDir });
    if (!materialized.ok) return { status: 'skipped', reason: materialized.reason, provider: normalized };
    const { registerProviderAuthProjection } = require('./native-auth-projection');
    const registration = registerProviderAuthProjection(fs, runtimeDir, normalized, {
      path: nodePath,
      aiHomeDir,
      respectDeletion: true,
      insertOnly: true
    });
    if (registration && registration.registered) {
      return {
        status: 'registered',
        reason: registration.reason,
        provider: normalized,
        accountRef: registration.accountRef || '',
        cliAccountId: String(registration.cliAccountId || ''),
        created: registration.reason === 'created'
      };
    }
    const reason = (registration && registration.reason) || 'host_auth_register_failed';
    return {
      status: reason === 'existing_account_unchanged' ? 'unchanged' : 'skipped',
      reason,
      provider: normalized,
      ...(registration && registration.accountRef ? { accountRef: registration.accountRef } : {})
    };
  } catch (error) {
    return {
      status: 'skipped',
      reason: error && error.code === 'account_deleted_by_user' ? 'account_deleted_by_user' : 'host_auth_scan_failed',
      provider: normalized
    };
  } finally {
    try {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    } catch (_error) {
      // 临时目录清不掉不影响结论；login 目录有自己的过期清理。
    }
  }
}

module.exports = { MAX_ARTIFACT_BYTES, inspectHostArtifacts, scanHostAuthProjection };
