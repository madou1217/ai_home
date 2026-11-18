'use strict';

// 远程账号备份的服务编排。
//
// 职责边界：
//   - 本模块只认识「目标 + 策略 + 清单」；
//   - SSH 细节在 strategies/ssh.js，未来 webdav 只需实现同样的
//     connect/readFile/writeFile/close 四个方法；
//   - 增量判断在 remote-backup-manifest.js，本模块不重复实现。

const fs = require('node:fs');
const os = require('node:os');

const { buildNativeExportDocument } = require('../native-account-transfer');
const { MANIFEST_FILE } = require('./remote-backup-manifest');
const {
  readBackupConfig,
  readBackupState,
  writeBackupConfig,
  writeBackupState
} = require('./remote-backup-config');
const { createBackupStrategy } = require('./strategies');
const { sftpOutcomeDetails } = require('../../runtime/sftp-outcome');
const { syncRepository, readSnapshot, readSnapshotObjects } = require('./repository-manifest');
const { layout } = require('./repository-object');
const { recoverRepository } = require('./repository-recovery');
const { coreAccounts } = require('./core-accounts');
const { readJsonValue } = require('../../server/app-state-store');
const { translateNodeAccount } = require('../go-bridge/go-import-translator');

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return new Date(value).toISOString();
}

function safeErrorMessage(error) {
  // 只保留错误码/短消息；SSH 错误里可能带路径，但不带私钥内容。
  const text = String(error && (error.code || error.message) || error || 'backup_failed');
  return text.slice(0, 300);
}

function createLogger(logger) {
  if (logger && typeof logger.info === 'function') return logger;
  return {
    info: (message) => console.log(`\x1b[36m[aih:backup]\x1b[0m ${message}`),
    warn: (message) => console.warn(`\x1b[33m[aih:backup]\x1b[0m ${message}`)
  };
}

function selectTargets(config, targetIds) {
  const all = Array.isArray(config.targets) ? config.targets : [];
  const ids = (Array.isArray(targetIds) ? targetIds : [])
    .map((item) => nonEmptyString(item))
    .filter(Boolean);
  if (ids.length === 0) return all.filter((target) => target.enabled);
  const selected = [];
  const unknown = [];
  for (const id of ids) {
    const target = all.find((item) => item.id === id)
      || all.find((item) => `${item.username}@${item.host}` === id);
    if (!target) {
      unknown.push(id);
      continue;
    }
    selected.push(target);
  }
  if (unknown.length > 0) throw new Error(`找不到备份目标：${unknown.join(', ')}`);
  return selected;
}

/** 本地账号 → 原生导出记录（与 `aih export` 同一份内容）。 */
async function buildLocalBackupAccounts(options = {}) {
  const fsImpl = options.fs || fs;
  const built = buildNativeExportDocument({
    fs: fsImpl,
    aiHomeDir: options.aiHomeDir,
    hostName: options.hostName || os.hostname()
  });
  const core = await coreAccounts(options.aiHomeDir, 'export', null, options);
  if (!core.ok || !Array.isArray(core.document?.accounts)) throw new Error(core.error || 'backup_core_export_failed');
  const records = new Map(core.document.accounts.map((record) => [record.accountRef, record]));
  const blocked = new Set((core.skipped || []).map((item) => item.accountRef));
  const links = readJsonValue(fsImpl, options.aiHomeDir, 'go-account-sync:state')?.links || {};
  for (const record of built.document.accounts) {
    if (records.has(record.accountRef) || blocked.has(record.accountRef)) continue;
    const linked = links[record.accountRef]?.goRef;
    let predicted = '';
    try { predicted = translateNodeAccount(record).predictedGoRef || ''; } catch (_) {}
    if ((linked && (records.has(linked) || blocked.has(linked))) || (predicted && (records.has(predicted) || blocked.has(predicted)))) continue;
    records.set(record.accountRef, record);
  }
  return { accounts: [...records.values()], skipped: [...(core.skipped || []), ...built.skipped.filter((item) => !records.has(item.accountRef) && !blocked.has(item.accountRef))] };
}

async function runTargetBackup(options = {}) {
  const target = options.target;
  const strategy = options.strategy;
  const hostName = options.hostName || os.hostname();
  const full = Boolean(options.full);
  const logger = options.logger;
  const startedAt = nowIso(options.now);

  await strategy.connect();
  const result = await syncRepository(strategy, { accounts: options.accounts, skipped: options.skipped, full, hostName });
  logger.info(`${target.id}: 上传 ${result.uploaded}，未变 ${result.unchanged}，删除标记 ${result.deleted}，revision ${result.manifest.revision}`);
  return {
    targetId: target.id, ok: result.incomplete.length === 0,
    ...(result.incomplete.length ? { error: 'backup_export_incomplete', skipped: result.incomplete } : {}),
    uploaded: result.uploaded, unchanged: result.unchanged, deleted: result.deleted,
    revision: result.manifest.revision, total: Object.keys(result.manifest.accounts).length, startedAt
  };
}

/**
 * 跑一轮备份。失败按目标隔离：一个目标连不上，其它目标继续。
 *
 * @returns {{ok: boolean, targets: Array<object>, accounts: number, skipped: Array<object>}}
 */
async function runRemoteBackup(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = nonEmptyString(options.aiHomeDir);
  if (!aiHomeDir) throw new Error('aiHomeDir is required');
  const logger = createLogger(options.logger);
  const config = options.config || readBackupConfig({ fs: fsImpl, aiHomeDir });
  const state = options.state || readBackupState({ fs: fsImpl, aiHomeDir });
  const targets = selectTargets(config, options.targetIds);
  if (targets.length === 0) {
    return { ok: true, targets: [], accounts: 0, skipped: [], reason: 'no_targets' };
  }

  const local = await buildLocalBackupAccounts({
    fs: fsImpl, aiHomeDir, hostName: options.hostName || os.hostname(),
    coreBinary: options.coreBinary, env: options.env, signal: options.signal
  });
  const createStrategy = typeof options.createStrategy === 'function' ? options.createStrategy : createBackupStrategy;
  const results = [];
  for (const target of targets) {
    const startedAt = nowIso(options.now);
    let strategy = null;
    try {
      strategy = createStrategy(target, {
        fs: fsImpl,
        env: options.env || process.env,
        onHostKey: (fingerprint) => {
          // TOFU：首次连接把指纹写回配置，之后就能校验。写失败不影响本次备份。
          try {
            const latest = readBackupConfig({ fs: fsImpl, aiHomeDir });
            const index = latest.targets.findIndex((item) => item.id === target.id);
            if (index >= 0 && !latest.targets[index].hostKeyFingerprint) {
              latest.targets[index] = { ...latest.targets[index], hostKeyFingerprint: fingerprint };
              writeBackupConfig({ fs: fsImpl, aiHomeDir, config: latest });
              logger.info(`${target.id}: 已记录主机指纹 ${fingerprint.slice(0, 12)}…`);
            }
          } catch (_ignored) {}
        }
      });
      const result = await runTargetBackup({
        target,
        strategy,
        accounts: local.accounts,
        skipped: local.skipped,
        full: options.full,
        hostName: options.hostName || os.hostname(),
        logger,
        now: options.now
      });
      results.push(result);
      state.targets[target.id] = {
        ...(state.targets[target.id] || {}),
        lastRunAt: result.startedAt,
        lastOkAt: result.ok ? result.startedAt : (state.targets[target.id]?.lastOkAt || ''),
        lastError: result.ok ? '' : result.error,
        recovery: null,
        uploaded: result.uploaded,
        unchanged: result.unchanged,
        deleted: result.deleted,
        revision: result.revision,
        total: result.total
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      results.push({
        targetId: target.id,
        ok: false,
        error: message,
        ...(sftpOutcomeDetails(error) ? { recovery: sftpOutcomeDetails(error) } : {}),
        uploaded: 0,
        unchanged: 0,
        deleted: 0,
        startedAt
      });
      state.targets[target.id] = {
        ...(state.targets[target.id] || {}),
        lastRunAt: startedAt,
        lastError: message,
        recovery: sftpOutcomeDetails(error),
        uploaded: 0,
        unchanged: 0,
        deleted: 0
      };
      logger.warn(`${target.id}: 备份失败（${message}）`);
    } finally {
      if (strategy && typeof strategy.close === 'function') {
        try { strategy.close(); } catch (_ignored) {}
      }
    }
  }
  try {
    writeBackupState({ fs: fsImpl, aiHomeDir, state });
  } catch (error) {
    logger.warn(`备份状态写入失败：${safeErrorMessage(error)}`);
  }
  return {
    ok: results.every((result) => result.ok),
    targets: results,
    accounts: local.accounts.length,
    skipped: local.skipped
  };
}

/** 只读查看远端清单（不写任何东西）。 */
async function inspectRemoteBackup(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = nonEmptyString(options.aiHomeDir);
  const config = options.config || readBackupConfig({ fs: fsImpl, aiHomeDir });
  const [target] = selectTargets(config, [options.targetId]);
  if (!target) throw new Error(`找不到备份目标：${nonEmptyString(options.targetId)}`);
  const createStrategy = typeof options.createStrategy === 'function' ? options.createStrategy : createBackupStrategy;
  const strategy = createStrategy(target, { fs: fsImpl, env: options.env || process.env });
  try {
    await strategy.connect();
    const snapshot = await readSnapshot(strategy);
    const manifest = snapshot.manifest;
    const stat = await strategy.statFile(snapshot.version === 2 ? layout.manifestPath : MANIFEST_FILE).catch(() => null);
    return {
      ok: true,
      targetId: target.id,
      manifest,
      bytes: stat && stat.size ? Number(stat.size) : 0,
      modifiedAt: stat && stat.mtime ? new Date(Number(stat.mtime) * 1000).toISOString() : ''
    };
  } finally {
    if (typeof strategy.close === 'function') {
      try { strategy.close(); } catch (_ignored) {}
    }
  }
}

/**
 * 从远端恢复账号：下载清单里所有非 tombstone 的账号文件，合并后走与
 * `aih import` 完全相同的导入器（同身份更新、新身份新增）。
 */
async function restoreRemoteBackup(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = nonEmptyString(options.aiHomeDir);
  if (!aiHomeDir) throw new Error('aiHomeDir is required');
  const config = options.config || readBackupConfig({ fs: fsImpl, aiHomeDir });
  const [target] = selectTargets(config, [options.targetId]);
  if (!target) throw new Error(`找不到备份目标：${nonEmptyString(options.targetId)}`);
  const createStrategy = typeof options.createStrategy === 'function' ? options.createStrategy : createBackupStrategy;
  const strategy = createStrategy(target, { fs: fsImpl, env: options.env || process.env });
  try {
    await strategy.connect();
    let snapshot;
    try { snapshot = await readSnapshotObjects(strategy); }
    catch (error) { return { ok: false, error: error.code || error.message, targetId: target.id, dryRun: Boolean(options.dryRun) }; }
    const manifest = snapshot.manifest;
    if (!manifest) return { ok: false, error: 'manifest_missing', targetId: target.id };
    const { accounts, missing, corrupt } = snapshot;
    if (missing.length || corrupt.length) {
      return { ok: false, error: 'backup_integrity_failed', targetId: target.id, missing, corrupt, revision: manifest.revision, dryRun: Boolean(options.dryRun) };
    }
    if (accounts.length === 0) {
      return { ok: false, error: 'no_accounts_in_backup', targetId: target.id, missing };
    }
    const input = { kind: 'aih-accounts', version: 1, accounts, compatibilityProjection: true };
    let result;
    try { result = await coreAccounts(aiHomeDir, 'import', input, { ...options, dryRun: Boolean(options.dryRun) }); }
    catch (error) {
      if (options.dryRun) throw error;
      return { ok: false, error: 'backup_core_mirror_incomplete', targetId: target.id,
        missing, revision: manifest.revision,
        compatibilityProjection: { protocol: '', status: 'unknown', applied: 0,
          canonicalStatus: 'unknown', outcomeUnknown: true } };
    }
    // Only Go's same-version canonical readback may write the retained view.
    // A missing marker (old Go), failure or lost reply never falls back to Node.
    const projection = result.compatibilityProjection;
    if (!options.dryRun && (!projection
      || projection.protocol !== 'aih-backup-compatibility-projection-v1'
      || projection.status !== 'applied' || projection.outcomeUnknown !== false
      || !Number.isSafeInteger(projection.applied) || projection.applied < 0
      || projection.applied !== (result.document?.accounts?.length || 0)
      || !['none', 'committed', 'partial'].includes(projection.canonicalStatus))) {
      return { ok: false, error: 'backup_core_mirror_incomplete', targetId: target.id,
        summary: result.summary, accounts: result.accounts, missing, revision: manifest.revision,
        compatibilityProjection: projection || { protocol: '', status: 'unknown', applied: 0,
          canonicalStatus: 'unknown', outcomeUnknown: true } };
    }
    return {
      ok: Boolean(result.ok) && !(result.summary?.invalid > 0 || result.summary?.failed > 0),
      ...((!result.ok || result.summary?.invalid > 0 || result.summary?.failed > 0) ? { error: result.error || 'backup_import_incomplete' } : {}),
      targetId: target.id,
      summary: result.summary,
      accounts: result.accounts,
      missing,
      revision: manifest.revision,
      dryRun: Boolean(options.dryRun),
      ...(!options.dryRun ? { compatibilityProjection: projection } : {})
    };
  } finally {
    if (typeof strategy.close === 'function') {
      try { strategy.close(); } catch (_ignored) {}
    }
  }
}

async function recoverRemoteBackup(options = {}) {
  const fsImpl = options.fs || fs;
  const config = options.config || readBackupConfig({ fs: fsImpl, aiHomeDir: options.aiHomeDir });
  const [target] = selectTargets(config, [options.targetId]);
  if (!target) throw new Error('backup_target_not_found');
  const strategy = (options.createStrategy || createBackupStrategy)(target, {
    fs: fsImpl, env: options.env || process.env, readOnly: true
  });
  try {
    await strategy.connect();
    return { targetId: target.id, ...await recoverRepository(strategy, options) };
  } finally { strategy.close(); }
}

module.exports = {
  buildLocalBackupAccounts,
  inspectRemoteBackup,
  restoreRemoteBackup,
  recoverRemoteBackup,
  runRemoteBackup,
  runTargetBackup,
  selectTargets
};
