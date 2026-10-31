'use strict';

/**
 * CodeBuddy 家族**唯一一份会话存储**。
 *
 * 家族四支客户端（`codebuddy` / `codebuddycn` / `workbuddy` / `workbuddycn`）跑的是
 * 同一套 CodeBuddy Code runtime，会话落盘同构：`<configDir>/projects/<sanitized-cwd>/<id>.jsonl`。
 * 此前 aih 只承认"地区内共用一份"（国内 = `~/.codebuddy-cn` + `~/.workbuddy`，
 * 国际 = `~/.codebuddy` + `~/.workbuddy-ai`），于是从国内站账号里看不到国际站历史，
 * 反过来也一样，`--resume` 更是只能列到本地区那一份。
 *
 * 用户口径（2026-10-31）：**家族会话不分地区，一份历史**。
 *
 * 落地方式不是"读的时候拼起来"——那样只有 aih 自己的列表能看到，CLI 的 `--resume`
 * 仍然只看得到自己配置根下的 `projects`。所以这里做的是**物理归一**：
 *   - 规范存储 = `~/.codebuddy/projects`（国际站 CLI 的默认会话根，也是 aih 一直在用的那份）
 *   - 其余三个配置根（`.codebuddy-cn` / `.workbuddy` / `.workbuddy-ai`）下的 `projects`
 *     变成指向它的符号链接
 * 链接一旦建立，账号投影里的 `projects`（本来就是指向宿主 `projects` 的软链接）也就
 * 顺着这条链落到同一份物理数据上：谁启动、从哪个地区启动，读写的都是同一批会话文件。
 *
 * 合并规则（对已有数据，绝不丢）：
 *   - 目标缺这个文件 → 移动过去（同一文件系统 rename，跨设备退化为 copy + unlink）
 *   - 目标已有同名文件 → 逐字节比较：内容相同视为同一份，删掉来源那份的重复拷贝；
 *     内容不同则**保留原位**并报 unresolved，该根不建链接（保持原来"各看各的"）
 *   - 目录里还剩东西（冲突或未知条目）→ 不删目录、不建链接，原样留着交给人判断
 * 也就是说：可以合并就合并，不能确定就什么都不动，绝不覆盖、绝不丢弃。
 *
 * 幂等：已经是链接的根只做目标校验，不重复搬运。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { FAMILY_PROVIDERS } = require('./codebuddy-family-layouts');
const { getProviderStoragePolicy } = require('./provider-storage-policy');

// 规范存储的配置根名。刻意选 `codebuddy` 那一支：它是国际站 CLI 的默认配置根，
// 也是 aih 早就预建、早就链接过去的那一份，不引入新路径、不新增备份/清理清单。
// 与 `getProviderStoragePolicy('codebuddy').nativeRoot` 的一致性由
// test/codebuddy-family-session-store.test.js 守卫。
const FAMILY_SESSION_STORE_CONFIG_DIR = '.codebuddy';
const SESSION_STORE_ENTRY = 'projects';

function familyConfigDirName(provider) {
  const policy = getProviderStoragePolicy(provider);
  const nativeRoot = policy && Array.isArray(policy.nativeRoot) ? policy.nativeRoot : [];
  return nativeRoot.length === 1 ? String(nativeRoot[0]) : '';
}

/** 家族规范会话存储的 HOME 相对段（`['.codebuddy', 'projects']`）。 */
function familySessionStoreSegments() {
  return Object.freeze([FAMILY_SESSION_STORE_CONFIG_DIR, SESSION_STORE_ENTRY]);
}

/**
 * 每个家族成员的原生配置根 + `projects`，规范存储排在最前。
 * 未知成员（布局表里没有对应 nativeRoot）直接跳过，不让"漏配一行"变成"删错目录"。
 */
function listFamilySessionRoots(hostHomeDir) {
  const home = String(hostHomeDir || '').trim();
  if (!home) return [];
  const roots = [];
  const seen = new Set();
  const push = (dirName) => {
    if (!dirName || seen.has(dirName)) return;
    seen.add(dirName);
    roots.push(Object.freeze({
      configDir: dirName,
      projectsRoot: nodePath.join(home, dirName, SESSION_STORE_ENTRY)
    }));
  };
  push(FAMILY_SESSION_STORE_CONFIG_DIR);
  for (const provider of FAMILY_PROVIDERS) push(familyConfigDirName(provider));
  return roots;
}

function lstatOrNull(fs, filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function samePath(pathImpl, left, right) {
  return pathImpl.resolve(left) === pathImpl.resolve(right);
}

function filesHaveSameContent(fs, left, right, leftSize, rightSize) {
  if (leftSize !== rightSize) return false;
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch (_error) {
    return false;
  }
}

function moveFile(fs, sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
    return true;
  }
}

/**
 * 把一个已有目录搬进规范存储。
 *
 * 返回 `{ moved, deduped, conflicts }`；`conflicts` 非空表示这个根不能动，
 * 调用方必须保留原目录、不建链接。
 */
function mergeDirectoryIntoStore(fs, sourceDir, targetDir, result) {
  let names;
  try {
    names = fs.readdirSync(sourceDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const name of names) {
    const sourcePath = nodePath.join(sourceDir, name);
    const targetPath = nodePath.join(targetDir, name);
    const sourceStat = lstatOrNull(fs, sourcePath);
    if (!sourceStat) continue;
    // 来源里已有的软链接不跟、不搬：可能是用户自己接到别处的会话目录，
    // 搬走等于替他改路径。留着这条根，交给人看。
    if (sourceStat.isSymbolicLink()) {
      result.conflicts.push(sourcePath);
      continue;
    }

    const targetStat = lstatOrNull(fs, targetPath);
    if (!targetStat) {
      fs.mkdirSync(targetDir, { recursive: true });
      if (sourceStat.isDirectory()) fs.renameSync(sourcePath, targetPath);
      else moveFile(fs, sourcePath, targetPath);
      result.moved += 1;
      continue;
    }

    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      mergeDirectoryIntoStore(fs, sourcePath, targetPath, result);
      // 子目录搬空后清掉，父目录才可能整体变空。
      try { fs.rmdirSync(sourcePath); } catch (_error) { /* 还有冲突项就留着 */ }
      continue;
    }

    if (sourceStat.isFile() && targetStat.isFile()) {
      if (filesHaveSameContent(fs, sourcePath, targetPath, sourceStat.size, targetStat.size)) {
        // 同一 sessionId 的同一份内容，目标已有一份，删掉重复拷贝不丢数据。
        fs.unlinkSync(sourcePath);
        result.deduped += 1;
        continue;
      }
      result.conflicts.push(sourcePath);
      continue;
    }

    // 目录 / 文件形态不一致：不动。
    result.conflicts.push(sourcePath);
  }
}

function isDirectoryEmpty(fs, dirPath) {
  try { return fs.readdirSync(dirPath).length === 0; } catch (_error) { return false; }
}

function createStoreLink(fs, pathImpl, platform, linkPath, targetPath) {
  fs.mkdirSync(pathImpl.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 把家族四个 `projects` 根收敛到同一份物理存储。
 *
 * 仅供 aih 启动家族 Provider 时调用（`session-store.js`），best-effort：任何失败都
 * 不阻断启动，行为退回"各看各的"。返回报告供测试与诊断使用。
 *
 * @returns {{
 *   canonical: string,
 *   linked: string[],
 *   adopted: string[],
 *   unchanged: string[],
 *   skipped: string[],
 *   unresolved: string[],
 *   failed: Array<{ path: string, error: string }>
 * }}
 */
function unifyFamilySessionStore(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = {
    canonical: '',
    linked: [],
    adopted: [],
    unchanged: [],
    skipped: [],
    unresolved: [],
    failed: []
  };
  if (!hostHomeDir) return result;

  const canonical = pathImpl.join(hostHomeDir, ...familySessionStoreSegments());
  result.canonical = canonical;

  for (const root of listFamilySessionRoots(hostHomeDir)) {
    if (samePath(pathImpl, root.projectsRoot, canonical)) {
      try { fs.mkdirSync(canonical, { recursive: true }); result.unchanged.push(root.projectsRoot); }
      catch (error) { result.failed.push({ path: root.projectsRoot, error: String(error && (error.code || error.message) || error) }); }
      continue;
    }

    try {
      const info = lstatOrNull(fs, root.projectsRoot);
      if (info && info.isSymbolicLink()) {
        let target = '';
        try { target = pathImpl.resolve(pathImpl.dirname(root.projectsRoot), fs.readlinkSync(root.projectsRoot)); }
        catch (_error) { target = ''; }
        if (target && samePath(pathImpl, target, canonical)) result.unchanged.push(root.projectsRoot);
        else result.unresolved.push(root.projectsRoot);
        continue;
      }

      if (!info) {
        fs.mkdirSync(canonical, { recursive: true });
        createStoreLink(fs, pathImpl, platform, root.projectsRoot, canonical);
        result.linked.push(root.projectsRoot);
        continue;
      }

      if (!info.isDirectory()) {
        result.unresolved.push(root.projectsRoot);
        continue;
      }

      fs.mkdirSync(canonical, { recursive: true });
      const merge = { moved: 0, deduped: 0, conflicts: [] };
      mergeDirectoryIntoStore(fs, root.projectsRoot, canonical, merge);
      if (merge.conflicts.length > 0) {
        result.unresolved.push(root.projectsRoot);
        continue;
      }
      if (!isDirectoryEmpty(fs, root.projectsRoot)) {
        // 正常不会走到：只剩无法识别、又没被判成冲突的条目。保持原样更安全。
        result.unresolved.push(root.projectsRoot);
        continue;
      }
      fs.rmdirSync(root.projectsRoot);
      createStoreLink(fs, pathImpl, platform, root.projectsRoot, canonical);
      result.adopted.push(root.projectsRoot);
    } catch (error) {
      result.failed.push({ path: root.projectsRoot, error: String(error && (error.code || error.message) || error) });
    }
  }

  return result;
}

module.exports = {
  FAMILY_SESSION_STORE_CONFIG_DIR,
  SESSION_STORE_ENTRY,
  familySessionStoreSegments,
  listFamilySessionRoots,
  unifyFamilySessionStore
};
