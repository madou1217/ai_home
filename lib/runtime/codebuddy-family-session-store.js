'use strict';

/**
 * CodeBuddy 家族的共享存储：**一份物理数据，其余全是链接**。
 *
 * 家族四支客户端（`codebuddy` / `codebuddycn` / `workbuddy` / `workbuddycn`）跑的是
 * 同一套 CodeBuddy Code runtime，落盘同构：
 *   - 会话：`<configDir>/projects/<sanitized-cwd>/<id>.jsonl`
 *   - harness：`<configDir>/skills`、`AGENTS.md`、`mcp.json`
 *
 * 目标（用户口径 2026-10-31）：家族不分地区，一份会话历史；同一套 harness 配置通用；
 * 且**磁盘上绝不允许出现第二份**。
 *
 * 实现原则（2026-10-31 二次修订，用户当场打回上一版）：
 *
 *   1. **运行期只建链接，绝不搬迁、绝不复制。**
 *      上一版在启动时把别处的 `projects` rename 进规范存储。多账号并发下这是错的：
 *      `aih codebuddy 1`、`aih codebuddycn 2`、WorkBuddy 桌面端可能同时在写同一个共享
 *      目录，把目录从别人脚下 rename 走等于制造半截状态。运行期任何树形移动都不能做。
 *
 *   2. 规范存储 = `~/.codebuddy`（国际站 CLI 的默认配置根，也是 aih 一直在用的那一份，
 *      不引入新路径）。其余三个配置根下的 `projects` / `skills` / `AGENTS.md` / `mcp.json`
 *      变成指向它的软链接。账号投影里的同名条目本来就指向宿主同名路径，顺着这条链落到
 *      同一份物理数据：多账号并发写的是**不同的会话文件**，天然安全。
 *
 *   3. 已经在磁盘上的真实目录（历史遗留、别处迁移过来的）**原样不动**，只报 unresolved。
 *      把它们并进规范存储是一次性的、需要独占的操作（没有进程在写），必须由人或显式命令
 *      在确认独占后执行，不能藏在每次启动里。
 *
 *   4. 建链本身是原子的：先在同目录建临时链接，再 rename 覆盖空目录位置，
 *      并发启动的两个进程最多互相覆盖同一个链接（幂等），不会出现半成品。
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

// 家族共享条目：会话（projects，只链接、绝不迁移）+ harness 配置（技能/指令/MCP）。
// harness 与 codex / claude 同口径：同一套 runtime 的配置只有一份。
const FAMILY_SHARED_ENTRIES = Object.freeze(['projects', 'skills', 'AGENTS.md', 'mcp.json']);
const SESSION_STORE_ENTRY = 'projects';

function familyConfigDirName(provider) {
  const policy = getProviderStoragePolicy(provider);
  const nativeRoot = policy && Array.isArray(policy.nativeRoot) ? policy.nativeRoot : [];
  return nativeRoot.length === 1 ? String(nativeRoot[0]) : '';
}

/** 家族规范存储的 HOME 相对段（`['.codebuddy', 'projects']`）。 */
function familySessionStoreSegments() {
  return Object.freeze([FAMILY_SESSION_STORE_CONFIG_DIR, SESSION_STORE_ENTRY]);
}

/** 家族成员的配置根名（含规范存储那一支），顺序稳定、去重。 */
function familyConfigDirNames() {
  const names = [FAMILY_SESSION_STORE_CONFIG_DIR];
  for (const provider of FAMILY_PROVIDERS) {
    const name = familyConfigDirName(provider);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 每个家族成员的原生配置根 + `projects`，规范存储排在最前。
 * 未知成员（布局表里没有对应 nativeRoot）直接跳过，不让"漏配一行"变成"删错目录"。
 */
function listFamilySessionRoots(hostHomeDir) {
  const home = String(hostHomeDir || '').trim();
  if (!home) return [];
  return familyConfigDirNames().map((configDir) => Object.freeze({
    configDir,
    projectsRoot: nodePath.join(home, configDir, SESSION_STORE_ENTRY)
  }));
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

function isSymbolicLinkTo(fs, pathImpl, linkPath, targetPath) {
  try {
    const raw = fs.readlinkSync(linkPath);
    return samePath(pathImpl, pathImpl.resolve(pathImpl.dirname(linkPath), raw), targetPath);
  } catch (_error) {
    return false;
  }
}

// 原子建链：同目录临时名 → rename 到位。两个进程同时跑也只会有一个胜出，
// 输的那个 rename 覆盖成一样的链接，不产生半成品、不碰任何数据。
function createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix) {
  fs.mkdirSync(pathImpl.dirname(linkPath), { recursive: true });
  const temporary = `${linkPath}.aih-link-${suffix}`;
  try { fs.unlinkSync(temporary); } catch (_error) { /* 上一轮的残留，忽略 */ }
  fs.symlinkSync(targetPath, temporary, platform === 'win32' ? 'junction' : 'dir');
  fs.renameSync(temporary, linkPath);
}

function isDirectoryEmpty(fs, dirPath) {
  try { return fs.readdirSync(dirPath).length === 0; } catch (_error) { return false; }
}

function linkSharedEntry(fs, pathImpl, platform, linkPath, targetPath, suffix, result) {
  const info = lstatOrNull(fs, linkPath);
  if (info && info.isSymbolicLink()) {
    if (isSymbolicLinkTo(fs, pathImpl, linkPath, targetPath)) result.unchanged.push(linkPath);
    else result.unresolved.push(linkPath);
    return;
  }

  const targetStat = lstatOrNull(fs, targetPath);
  if (!info) {
    // 规范存储里还没有这份条目就不凭空造（AGENTS.md 是用户写的，mcp.json 是配置），
    // 等它出现，下一次启动再链接。
    if (!targetStat) return;
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix);
    result.linked.push(linkPath);
    return;
  }

  if (info.isDirectory() && isDirectoryEmpty(fs, linkPath)) {
    fs.rmdirSync(linkPath);
    if (!targetStat) fs.mkdirSync(targetPath, { recursive: true });
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix);
    result.linked.push(linkPath);
    return;
  }

  // 真实目录/文件且里面有东西：**不搬、不删、不复制**。留给显式独占操作。
  result.unresolved.push(linkPath);
}

/**
 * 让家族四个配置根上的共享条目都指向同一份物理存储。
 *
 * 只做三种动作：目标缺失→建链；已是指向规范存储的链→跳过；空目录→删空目录再建链。
 * 真实目录/文件（里面有内容）一律**不动**，计入 `unresolved`，等显式独占操作处理。
 *
 * best-effort：任何失败都不阻断启动。
 *
 * @returns {{ canonical: string, linked: string[], unchanged: string[], unresolved: string[], failed: Array<{ path: string, error: string }> }}
 */
function ensureFamilySessionLinks(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = { canonical: '', linked: [], unchanged: [], unresolved: [], failed: [] };
  if (!hostHomeDir) return result;

  const canonicalRoot = pathImpl.join(hostHomeDir, FAMILY_SESSION_STORE_CONFIG_DIR);
  result.canonical = pathImpl.join(canonicalRoot, SESSION_STORE_ENTRY);

  try {
    fs.mkdirSync(canonicalRoot, { recursive: true });
    // 会话存储总是要有宿主那一份：链接得有目标可指（与 precreatedDirectories 同口径）。
    fs.mkdirSync(pathImpl.join(canonicalRoot, SESSION_STORE_ENTRY), { recursive: true });
  } catch (error) {
    result.failed.push({ path: canonicalRoot, error: String((error && (error.code || error.message)) || error) });
    return result;
  }

  const suffix = `${Number(options.pid) || process.pid}-${Date.now()}`;
  for (const root of listFamilySessionRoots(hostHomeDir)) {
    // 规范存储那一支不需要自链。
    if (root.configDir === FAMILY_SESSION_STORE_CONFIG_DIR) continue;
    for (const entry of FAMILY_SHARED_ENTRIES) {
      const linkPath = pathImpl.join(hostHomeDir, root.configDir, entry);
      const targetPath = pathImpl.join(canonicalRoot, entry);
      try {
        linkSharedEntry(fs, pathImpl, platform, linkPath, targetPath, suffix, result);
      } catch (error) {
        result.failed.push({ path: linkPath, error: String((error && (error.code || error.message)) || error) });
      }
    }
  }

  return result;
}

module.exports = {
  FAMILY_SESSION_STORE_CONFIG_DIR,
  FAMILY_SHARED_ENTRIES,
  SESSION_STORE_ENTRY,
  familyConfigDirNames,
  familySessionStoreSegments,
  listFamilySessionRoots,
  ensureFamilySessionLinks
};
