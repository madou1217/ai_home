'use strict';

// **zcode 投影身份漂移的自动收敛**（观察者，与宿主登录态观察者同一套生命周期）。
//
// 场景（真机 2026-10-27）：WebUI 打开某账号的 Desktop → Desktop 要求登录 → 用户登成了
// **另一个身份**（126 → gmail）。桌面端把新身份的凭据写进**该账号的投影**，于是：
//   * 投影里的身份 ≠ 账号身份（判据见 zcode-projection-identity）；
//   * aih 当时把它当同一账号采用（连 DB 快照都被覆盖），两个上游身份共用一条记录
//     —— 额度/用量历史、套餐归属全部混在一起。
//
// 用户选定的语义（2026-10-27）：**把新身份登记成独立账号，旧账号标记为「登录态已被替换」**，
// 两条身份不再共用一条记录。因此本观察者做三件事，全部幂等：
//   1) 把新身份按既有注册链路登记（respectDeletion：用户删过的身份不会被自动复活）；
//   2) 把投影里**承载身份**的文件搬到新账号的投影（登录态跟着身份走，新账号立刻可用）；
//   3) 清掉旧账号 DB 快照里**已被采用的外来凭据**（旧账号因此不再带别人的登录态，
//      界面上表现为需要重新登录；用户若在桌面端登回旧身份，投影/快照会自然恢复）。
//
// 纪律：自动观察不是用户显式登记 —— 一切失败都只记进 summary 并保持原样（fail-closed），
// 绝不半搬半删；注册走 `registerAccountIdentity`，不另起一套写库路径。

const nodePath = require('node:path');
const {
  ZCODE_PROJECTION_IDENTITY_FILES,
  resolveZcodeProjectionDir,
  resolveZcodeNativeAuthIdentity,
  detectZcodeProjectionIdentityDrift
} = require('./zcode-projection-identity');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createZcodeProjectionIdentitySync(deps = {}) {
  const fs = deps.fs;
  const aiHomeDir = normalizeText(deps.aiHomeDir);
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const now = deps.now || Date.now;
  const register = deps.registerAccountIdentity
    || ((...args) => require('./account-registration').registerAccountIdentity(...args));
  const listAccounts = deps.listAccountRefRecords
    || ((...args) => require('../server/account-ref-store').listAccountRefRecords(...args));
  const writeNativeAuth = deps.writeAccountNativeAuth
    || ((...args) => require('../server/account-credential-store').writeAccountNativeAuth(...args));

  let timer = null;
  let running = false;
  let lastStamp = '';
  let lastScan = { scanned: 0, reconciled: [], skipped: [] };
  const reconciled = [];

  function accountRefs() {
    try {
      const rows = listAccounts(fs, aiHomeDir, 'zcode', { createIfMissing: false }) || [];
      return rows.map((row) => normalizeText(row && row.accountRef)).filter(Boolean);
    } catch (_error) {
      return [];
    }
  }

  // 便宜的变更门：所有被观察投影文件的 stamp 没变就不重扫（与通用宿主观察者同款）。
  function computeStamp(refs) {
    const parts = [];
    for (const accountRef of refs) {
      const dir = resolveZcodeProjectionDir(aiHomeDir, accountRef);
      for (const name of ZCODE_PROJECTION_IDENTITY_FILES) {
        const file = dir ? nodePath.join(dir, name) : '';
        if (!file) continue;
        try {
          const stat = fs.lstatSync(file);
          parts.push(`${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`);
        } catch (_error) {
          parts.push(`${file}:-`);
        }
      }
    }
    return parts.join('|');
  }

  /** 把投影里承载身份的文件搬到目标账号的投影（同盘 rename，跨盘回退复制）。 */
  function moveProjectionIdentityFiles(fromRef, toRef) {
    const fromDir = resolveZcodeProjectionDir(aiHomeDir, fromRef);
    const toDir = resolveZcodeProjectionDir(aiHomeDir, toRef);
    if (!fromDir || !toDir) throw new Error('zcode_projection_dir_unresolved');
    fs.mkdirSync(toDir, { recursive: true, mode: 0o700 });
    const moved = [];
    for (const name of ZCODE_PROJECTION_IDENTITY_FILES) {
      const source = nodePath.join(fromDir, name);
      const target = nodePath.join(toDir, name);
      let stat = null;
      try { stat = fs.statSync(source); } catch (_error) { continue; }
      if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) continue;
      try {
        fs.renameSync(source, target);
      } catch (_renameError) {
        fs.copyFileSync(source, target);
        fs.unlinkSync(source);
      }
      moved.push(name);
    }
    return moved;
  }


  function scan() {
    if (running) return lastScan;
    running = true;
    try {
      const refs = accountRefs();
      const stamp = computeStamp(refs);
      if (stamp && stamp === lastStamp) return lastScan;
      const summary = { scanned: refs.length, reconciled: [], skipped: [] };
      for (const accountRef of refs) {
        let drift = { drifted: false, reason: 'unknown', projection: null };
        try {
          drift = detectZcodeProjectionIdentityDrift({ fs, aiHomeDir, accountRef });
        } catch (error) {
          summary.skipped.push({ accountRef, reason: `detect_failed:${normalizeText(error && error.message)}` });
          continue;
        }
        if (!drift.drifted) continue;
        const projection = drift.projection || {};
        const newRef = normalizeText(projection.canonicalAccountRef);
        if (!newRef || newRef === accountRef) continue;
        try {
          const registration = register(fs, aiHomeDir, {
            provider: 'zcode',
            identitySeed: projection.identitySeed,
            respectDeletion: true
          });
          const targetRef = normalizeText(registration && registration.accountRef) || newRef;
          const moved = moveProjectionIdentityFiles(accountRef, targetRef);
          // 新账号：把搬过来的登录态同时写进它的 **DB 快照**。
          // 为什么必须写：状态门（checkStatus.configured）与 CLI 列表读的是 DB 快照，
          // 只把文件搬到投影里的话，新账号会被判成「未配置/待登录」而不进运行池 ——
          // 真机表现就是「新账号出现了但不可用」。
          try {
            if (projection.credentials && typeof projection.credentials === 'object') {
              writeNativeAuth(fs, aiHomeDir, targetRef, { credentials: projection.credentials });
            }
          } catch (_writeError) {
            summary.skipped.push({ accountRef: targetRef, reason: 'native_auth_write_failed' });
          }
          // 旧账号：**只有**当它 DB 快照里装的也是那个外来身份时才清（那才是「这个账号被换成别人」）。
          // 若 DB 快照仍是它自己的身份（只是沙箱里被登过别人），凭据是它自己的，绝不能清 ——
          // 真机教训：第一版只看投影就清，把一个手机号账号自己的凭据清掉了。
          let clearedForeignCredentials = false;
          try {
            const dbIdentity = resolveZcodeNativeAuthIdentity({ fs, aiHomeDir, accountRef });
            // 比**身份种子**而不是比 ref：改口径（区域参与身份）后 ref 可能仍是旧口径铸的，
            // 比种子才能回答「DB 里装的是不是投影里那个身份」。
            if (dbIdentity.present && dbIdentity.identitySeed
              && dbIdentity.identitySeed === projection.identitySeed) {
              writeNativeAuth(fs, aiHomeDir, accountRef, {});
              clearedForeignCredentials = true;
            }
          } catch (_clearError) {
            summary.skipped.push({ accountRef, reason: 'native_auth_clear_failed' });
          }
          const entry = {
            at: now(),
            accountRef,
            replacedByAccountRef: targetRef,
            cliAccountId: Number(registration && registration.cliAccountId) || 0,
            email: projection.email,
            displayName: projection.displayName,
            moved,
            clearedForeignCredentials
          };
          summary.reconciled.push(entry);
          reconciled.push(entry);
        } catch (error) {
          // 用户在别处删过这个身份 → 尊重删除，不登记、不搬迁。
          summary.skipped.push({
            accountRef,
            reason: `register_failed:${normalizeText((error && error.code) || (error && error.message))}`
          });
        }
      }
      lastStamp = stamp;
      lastScan = summary;
      return summary;
    } finally {
      running = false;
    }
  }

  return {
    id: 'zcode-projection-identity',
    scan,
    start(options = {}) {
      if (timer) return;
      const intervalMs = Math.max(5000, Number(options && options.intervalMs) || 30000);
      const onUpdated = options && typeof options.onUpdated === 'function' ? options.onUpdated : null;
      const onError = options && typeof options.onError === 'function' ? options.onError : null;
      timer = setIntervalImpl(() => {
        try {
          const summary = scan();
          if (summary && summary.reconciled && summary.reconciled.length > 0 && onUpdated) onUpdated(summary);
        } catch (error) {
          if (onError) onError(`zcode_projection_identity_scan_failed:${normalizeText(error && error.message)}`);
        }
      }, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = null;
    },
    getStats() {
      return {
        running: Boolean(timer),
        scanned: Number(lastScan.scanned) || 0,
        reconciledCount: reconciled.length,
        lastReconciled: reconciled.slice(-5),
        lastSkipped: (lastScan.skipped || []).slice(-5)
      };
    }
  };
}

module.exports = { createZcodeProjectionIdentitySync };
