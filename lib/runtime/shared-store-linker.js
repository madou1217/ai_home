'use strict';

/**
 * 共享存储链接器（provider 无关的原语层）。
 *
 * 背景：多个 provider 把「产品级会话数据」和「账号私有身份」放在同一个数据根下，
 * 且都**没有** env 开关能把两者拆开（zcode 的 `<base>/.zcode`、cline 的
 * `<CLINE_DIR>/data`）。aih 的隔离口径是：身份/凭据留在账号投影里，会话数据链回宿主
 * 那一份（会话不属于某个账号），于是每个账号的客户端、以及宿主自己的 CLI 看到的是
 * 同一批会话。
 *
 * 本模块只做「按声明表建链接」这件事，不认任何 provider：
 *   - 目录 → 目录符号链接；文件 → 文件符号链接；
 *   - SQLite 的 `-wal` / `-shm` 侧车按「悬挂链接」处理（SQLite 通过链接创建共享目标）；
 *   - 幂等：每次启动都跑，链接已指向正确目标时零动作。
 *
 * SQLite WAL 说明（与 zcode 一致，已实测）：
 *   - 锁与 IO 都经符号链接落到共享 inode，多个客户端共享同一份 WAL 是安全的；
 *   - 干净关闭会经投影路径删掉 `<db>-wal`，那只会删掉这条投影链接，共享目标不受影响，
 *     下次启动重建（本模块每次启动都跑）。
 *
 * 真实残留数据（投影里已经存在的**真实**文件/目录）默认**不动**：
 *   - `discardRealEntries: true`（zcode 口径）：直接就地删除后建链；
 *   - `discardRealEntries: false`（cline 口径）：记入 `unresolved` 并跳过该条目建链，
 *     交由调用方的 `adopt` 钩子先把真实数据接管到宿主存储里，绝不静默丢弃。
 *
 * 一切失败都只记进 summary，绝不抛出：链接是启动路径上的 best-effort 增强。
 */

function normalizeForCompare(value) {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInsidePath(child, parent) {
  const childNorm = normalizeForCompare(child);
  const parentNorm = normalizeForCompare(parent);
  if (!childNorm || !parentNorm) return false;
  return childNorm === parentNorm || childNorm.startsWith(`${parentNorm}/`);
}

function createSummary() {
  return {
    linked: 0,
    discarded: 0,
    adopted: 0,
    unresolved: [],
    deferred: '',
    skipped: '',
    errors: []
  };
}

/**
 * @param {Object} input
 * @param {any} [input.fs] 注入的 node:fs（缺省用真实 fs，便于测试）
 * @param {any} [input.path] 注入的 node:path
 * @param {string} input.projectionRoot 账号投影里的数据根（如 `<sandbox>/.cline`）
 * @param {string} input.sharedRoot 宿主侧共享数据根（如 `<hostHome>/.cline`）
 * @param {string[][]} [input.dirEntries] 需要链接的目录（相对数据根的分段）
 * @param {string[][]} [input.fileEntries] 需要链接的文件
 * @param {string[][]} [input.sidecarEntries] 悬挂链接（wal/shm 之类）
 * @param {Function} [input.adopt] 建链前的一次性接管钩子；返回 `{ ok: false }` 时本轮
 *        **整体不建链**（fail-closed），并把 `reason` 记为 `deferred`。
 * @param {boolean} [input.discardRealEntries] 真实残留是否可丢弃（见文件头说明）
 * @returns {{linked: number, discarded: number, adopted: number, unresolved: string[], deferred: string, skipped: string, errors: string[]}}
 */
function ensureSharedStoreEntries(input = {}) {
  const fs = input.fs || require('node:fs');
  const path = input.path || require('node:path');
  const projectionRoot = String(input.projectionRoot || '').trim();
  const sharedRoot = String(input.sharedRoot || '').trim();
  const dirEntries = Array.isArray(input.dirEntries) ? input.dirEntries : [];
  const fileEntries = Array.isArray(input.fileEntries) ? input.fileEntries : [];
  const sidecarEntries = Array.isArray(input.sidecarEntries) ? input.sidecarEntries : [];
  const discardRealEntries = input.discardRealEntries === true;
  const summary = createSummary();

  if (!projectionRoot || !sharedRoot) {
    summary.skipped = 'missing-root';
    return summary;
  }
  // Fail-closed：投影本身就是宿主（无 auth 投影时 provider 直接跑在真实 HOME 下），
  // 或共享根落在投影内部（自链接）——两种情况都绝不建链。
  if (normalizeForCompare(projectionRoot) === normalizeForCompare(sharedRoot)) {
    summary.skipped = 'projection-is-shared-root';
    return summary;
  }
  if (isInsidePath(sharedRoot, projectionRoot)) {
    summary.skipped = 'shared-root-inside-projection';
    return summary;
  }

  const lstat = (targetPath) => {
    try {
      return fs.lstatSync(targetPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  const linkPointsTo = (linkPath, target) => {
    try {
      const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      return normalizeForCompare(resolved) === normalizeForCompare(target);
    } catch (_error) {
      return false;
    }
  };

  // 建链前的一次性接管（真实数据 → 宿主共享存储）。钩子自己决定能不能接管：
  // 接管不了就返回 ok:false，本轮整体不建链（fail-closed，绝不静默丢弃数据）。
  if (typeof input.adopt === 'function') {
    try {
      const result = input.adopt({ fs, path, projectionRoot, sharedRoot }) || {};
      summary.adopted += Number(result.adopted) || 0;
      if (Array.isArray(result.unresolved)) {
        summary.unresolved.push(...result.unresolved.map(String));
      }
      if (result.ok === false) {
        summary.deferred = String(result.reason || 'adopt-declined');
        summary.unresolved = Array.from(new Set(summary.unresolved.filter(Boolean)));
        return summary;
      }
    } catch (error) {
      summary.deferred = `adopt-error:${(error && error.code) || 'error'}`;
      summary.unresolved = Array.from(new Set(summary.unresolved.filter(Boolean)));
      return summary;
    }
  }

  // 真实（非链接）数据落在共享路径上：
  //   - 空目录没有任何数据，两种口径下都可安全替换成链接（adopt 搬空后就是这种形态）；
  //   - 有内容的真实数据：`discardRealEntries` 才可丢弃，否则报 unresolved 并跳过建链。
  const isDisposableEmptyDir = (srcPath, stat) => {
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    try {
      return fs.readdirSync(srcPath).length === 0;
    } catch (_error) {
      return false;
    }
  };

  const resolveRealEntry = (srcPath, stat, label) => {
    if (discardRealEntries || isDisposableEmptyDir(srcPath, stat)) {
      if (stat.isDirectory()) fs.rmSync(srcPath, { recursive: true, force: true });
      else fs.unlinkSync(srcPath);
      summary.discarded += 1;
      return true;
    }
    summary.unresolved.push(label);
    return false;
  };

  const ensureDirLink = (segments) => {
    const src = path.join(projectionRoot, ...segments);
    const dst = path.join(sharedRoot, ...segments);
    const label = segments.join('/');
    const stat = lstat(src);
    if (stat && stat.isSymbolicLink()) {
      if (linkPointsTo(src, dst)) return;
      fs.unlinkSync(src);
    } else if (stat) {
      if (!resolveRealEntry(src, stat, label)) return;
    }
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.symlinkSync(dst, src, 'junction');
    summary.linked += 1;
  };

  const ensureFileLink = (segments, options = {}) => {
    const src = path.join(projectionRoot, ...segments);
    const dst = path.join(sharedRoot, ...segments);
    const label = segments.join('/');
    const stat = lstat(src);
    if (stat && stat.isSymbolicLink()) {
      if (linkPointsTo(src, dst)) return;
      fs.unlinkSync(src);
    } else if (stat) {
      if (!resolveRealEntry(src, stat, label)) return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!lstat(dst) && options.dangling !== true) {
      // 空文件是合法的全新 SQLite 数据库；wal/shm 保持悬挂——SQLite 会通过链接
      // 创建共享目标。
      fs.writeFileSync(dst, '');
    }
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.symlinkSync(dst, src, 'file');
    summary.linked += 1;
  };

  const run = (label, fn) => {
    try {
      fn();
    } catch (error) {
      summary.errors.push(`${label}:${error && error.code ? error.code : 'error'}`);
    }
  };

  for (const segments of dirEntries) {
    run(segments.join('/'), () => ensureDirLink(segments));
  }
  for (const segments of fileEntries) {
    run(segments.join('/'), () => ensureFileLink(segments));
  }
  for (const segments of sidecarEntries) {
    run(segments.join('/'), () => ensureFileLink(segments, { dangling: true }));
  }
  summary.unresolved = Array.from(new Set(summary.unresolved.filter(Boolean)));
  return summary;
}

module.exports = {
  ensureSharedStoreEntries,
  createSummary,
  isInsidePath,
  normalizeForCompare
};
