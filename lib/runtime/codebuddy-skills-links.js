'use strict';

/**
 * CodeBuddy 家族的**技能（skills）**：公用实体 + 账号级启用。
 *
 * 用户口径（2026-10-31）：skills 和会话一样是公用的，不是每个账号各装一份；账号级
 * 只是"启用哪些"。默认全开；来源失效（共享库里那个技能被删了）就静默丢弃，不报错。
 *
 * 落盘形态：
 *   ~/.codebuddy/skills/<skill>                      唯一实体（公用，只装一次）
 *   <账号投影>/<configDir>/skills/<skill> -> 上面的实体   （每个启用的技能一条软链接）
 *
 * 为什么逐技能链接而不是整目录链接：整目录链接后，所有账号看到的是同一份列表，
 * "这个账号启用哪些"就没地方放了；逐技能链接让启用/禁用只是加/删一条链接 ——
 * 不复制、不移动技能实体，也不影响别的账号。
 *
 * 只用软链接；不 rename、不 hardlink（user 2026-10-31 明确）。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const SKILL_ENTRY_FILE = 'SKILL.md';

function lstatOrNull(fs, filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readDirNames(fs, dirPath) {
  try { return fs.readdirSync(dirPath); } catch (_error) { return []; }
}

function isDirectory(fs, dirPath) {
  try { return fs.statSync(dirPath).isDirectory(); } catch (_error) { return false; }
}

/** 共享库里的技能清单（只认目录，优先认带 SKILL.md 的目录）。 */
function listStoreSkills(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const storeDir = String(options.storeSkillsDir || '').trim();
  if (!storeDir) return [];
  const skills = [];
  for (const name of readDirNames(fs, storeDir)) {
    if (name.startsWith('.')) continue;
    const dirPath = pathImpl.join(storeDir, name);
    if (!isDirectory(fs, dirPath)) continue;
    const hasManifest = Boolean(lstatOrNull(fs, pathImpl.join(dirPath, SKILL_ENTRY_FILE)));
    skills.push(Object.freeze({ name, dirPath, hasManifest }));
  }
  // 带清单的排前面，其余保持字母序（渲染顺序稳定）。
  skills.sort((left, right) => (Number(right.hasManifest) - Number(left.hasManifest))
    || left.name.localeCompare(right.name));
  return skills;
}

function linkPointsTo(fs, pathImpl, linkPath, targetPath) {
  try {
    const raw = fs.readlinkSync(linkPath);
    return pathImpl.resolve(pathImpl.dirname(linkPath), raw) === pathImpl.resolve(targetPath);
  } catch (_error) {
    return false;
  }
}

/**
 * 让账号投影里的 skills/ 精确等于"启用集合"的链接视图。
 *
 * @param {{fs?: any, path?: any, storeSkillsDir: string, accountSkillsDir: string,
 *          disabledSkills?: string[], enabledSkills?: string[]}} input
 * @returns {{ linked: number, removed: number, kept: number, skipped: string[], unresolved: string[] }}
 */
function reconcileAccountSkillLinks(input = {}) {
  const fs = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const storeSkillsDir = String(input.storeSkillsDir || '').trim();
  const accountSkillsDir = String(input.accountSkillsDir || '').trim();
  const result = { linked: 0, removed: 0, kept: 0, skipped: [], unresolved: [] };
  if (!storeSkillsDir || !accountSkillsDir) return result;

  // 账号目录不能是"整目录链接"（旧布局）：摘掉链接本身即可，实体在共享库里不会丢。
  const accountDirStat = lstatOrNull(fs, accountSkillsDir);
  if (accountDirStat && accountDirStat.isSymbolicLink()) {
    try { fs.unlinkSync(accountSkillsDir); result.removed += 1; } catch (_error) { return result; }
  }
  try { fs.mkdirSync(accountSkillsDir, { recursive: true }); } catch (_error) { return result; }

  const disabled = new Set((Array.isArray(input.disabledSkills) ? input.disabledSkills : []).map((name) => String(name || '').trim()).filter(Boolean));
  const enabledOnly = Array.isArray(input.enabledSkills) && input.enabledSkills.length > 0
    ? new Set(input.enabledSkills.map((name) => String(name || '').trim()).filter(Boolean))
    : null;

  const storeSkills = listStoreSkills({ fs, path: pathImpl, storeSkillsDir });
  const wanted = new Map();
  for (const skill of storeSkills) {
    if (disabled.has(skill.name)) continue;
    if (enabledOnly && !enabledOnly.has(skill.name)) continue;
    wanted.set(skill.name, skill.dirPath);
  }

  // 1) 清掉不再需要的链接：禁用的、来源已失效的（静默丢弃）。
  for (const name of readDirNames(fs, accountSkillsDir)) {
    const linkPath = pathImpl.join(accountSkillsDir, name);
    const stat = lstatOrNull(fs, linkPath);
    if (!stat) continue;
    if (!stat.isSymbolicLink()) {
      // 账号自己放的真实目录/文件不动，也不参与启用集合（交给用户）。
      if (!wanted.has(name)) result.unresolved.push(name);
      continue;
    }
    const targetExists = Boolean(lstatOrNull(fs, linkPath));
    const stillWanted = wanted.has(name) && linkPointsTo(fs, pathImpl, linkPath, wanted.get(name));
    if (stillWanted && targetExists) { result.kept += 1; continue; }
    try {
      fs.unlinkSync(linkPath);
      result.removed += 1;
    } catch (_error) {
      result.unresolved.push(name);
    }
  }

  // 2) 补上缺失的链接。来源失效（enabled 但实体不在）静默跳过。
  for (const [name, targetPath] of wanted) {
    const linkPath = pathImpl.join(accountSkillsDir, name);
    const stat = lstatOrNull(fs, linkPath);
    if (stat) {
      if (stat.isSymbolicLink() && linkPointsTo(fs, pathImpl, linkPath, targetPath)) { result.kept += 1; continue; }
      if (!stat.isSymbolicLink()) { result.unresolved.push(name); continue; }
    }
    if (!lstatOrNull(fs, targetPath)) { result.skipped.push(name); continue; }
    try {
      fs.symlinkSync(targetPath, linkPath, 'dir');
      result.linked += 1;
    } catch (_error) {
      result.unresolved.push(name);
    }
  }

  return result;
}

module.exports = {
  SKILL_ENTRY_FILE,
  listStoreSkills,
  reconcileAccountSkillLinks
};
