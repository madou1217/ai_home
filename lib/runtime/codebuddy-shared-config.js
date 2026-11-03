'use strict';

/**
 * CodeBuddy 家族的**CLI 配置**共享：settings.json + statusLine 脚本。
 *
 * 用户口径（2026-11-01）：非授权类的配置文件家族里只留一份——哪个账号改的，
 * 其它账号下次启动就是新值，不再每个账号各配一遍。
 *
 * 落盘形态：
 *   ~/.codebuddy/settings.json                 唯一实体（规范存储）
 *   ~/.codebuddy-cn/settings.json -> 上面那份    （宿主另一支）
 *   <账号投影>/<configDir>/settings.json -> 上面那份（每个账号一条链接）
 *   statusline-command.sh 同理。settings.json 里的 statusLine.command 一律改指
 *   规范脚本的绝对路径（CLI 在沙箱里跑，HOME 是投影，不能用 ~ 展开）。
 *
 * **不是**家族所有配置根都适用：WorkBuddy 桌面端（`.workbuddy-ai` / `.workbuddy`）
 * 的 settings.json 是桌面 App 自己的配置（sandbox 白名单、claw 渠道账号、office 文件
 * 关联标记，实测 29 KB 级），与 CLI 那份（enabledPlugins / trustedDirectories /
 * model / theme / statusLine，几百字节）不是同一套 schema。把两者归一等于用 CLI 的
 * 小 JSON 覆盖桌面配置，所以那两支保持原样。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { writeFileAtomic } = require('./atomic-file-write');

const SETTINGS_FILE = 'settings.json';
const STATUSLINE_SCRIPT_FILE = 'statusline-command.sh';
// IDE 启动参数（locale / 硬件加速 / crash reporter）。它不是 JSON——文件里带 // 注释，
// 所以按"整份文件取新版"处理，不做键级合并。
const ARGV_FILE = 'argv.json';
// 会话产物：历史、文件快照、计划、任务、shell 快照、附件 blob。
// 用户口径（2026-11-01）：会话只能有一份，不能每个账号/客户端各存一份。
const HISTORY_FILE = 'history.jsonl';
const SESSION_ARTIFACT_ENTRIES = Object.freeze([
  HISTORY_FILE,
  'file-history',
  'plans',
  'tasks',
  'shell-snapshots',
  'blobs'
]);
// 技能实体：账号按技能链接，客户端根整目录链接到规范存储。
const SKILLS_DIR = 'skills';
// 插件安装体：只有 CodeBuddy 两支 CLI 是同一套插件目录布局
// （marketplaces/ + known_marketplaces.json）；WorkBuddy 桌面是
// installed_plugins.json / configured-plugins.json，混在一起会互相污染。
const PLUGINS_DIR = 'plugins';

// 只对「同一套 CLI 配置 schema」的配置根生效。第一个是规范存储。
const CLI_CONFIG_ROOTS = Object.freeze(['.codebuddy', '.codebuddy-cn']);
const CANONICAL_CONFIG_ROOT = '.codebuddy';
const CLI_SHARED_CONFIG_ENTRIES = Object.freeze([SETTINGS_FILE, STATUSLINE_SCRIPT_FILE, ARGV_FILE]);

function isCliSharedConfigEntry(name) {
  const entry = String(name || '').trim();
  return CLI_SHARED_CONFIG_ENTRIES.includes(entry);
}

function isCliConfigRoot(dirName) {
  return CLI_CONFIG_ROOTS.includes(String(dirName || '').trim());
}

/** 规范 statusLine 脚本的绝对路径（宿主 HOME 下，与投影 HOME 无关）。 */
function canonicalStatuslineScriptPath(hostHomeDir, pathImpl = nodePath) {
  const home = String(hostHomeDir || '').trim();
  return home ? pathImpl.join(home, CANONICAL_CONFIG_ROOT, STATUSLINE_SCRIPT_FILE) : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJsonObject(fs, filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function statOrNull(fs, filePath) {
  try { return fs.statSync(filePath); } catch (_error) { return null; }
}

function lstatOrNull(fs, filePath) {
  try { return fs.lstatSync(filePath); } catch (_error) { return null; }
}

// 字符串数组做并集（trustedDirectories / permissions.allow 这类"清单"）：用户的意图是
// "每个账号都一样"，所以缺的补上、已有的不动、顺序保持 target 在前。
// 对象数组（比如 sandbox.orderedRules）不在这里并，交给专门的按 id 合并。
function isScalarArray(value) {
  return Array.isArray(value) && value.every((item) => (
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  ));
}

function unionScalarArrays(target, source) {
  const merged = [...target];
  for (const item of source) {
    if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) merged.push(item);
  }
  return merged;
}

// 规范存储优先：source 只补 target 缺的键。对象递归合并；标量数组取并集；
// 其它冲突（标量 / 对象数组）保留 target —— 「先入为主」。
function mergeSettingsObjects(target, source) {
  if (!isPlainObject(target)) return isPlainObject(source) ? { ...source } : {};
  if (!isPlainObject(source)) return { ...target };
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
      continue;
    }
    if (isPlainObject(merged[key]) && isPlainObject(value)) {
      merged[key] = mergeSettingsObjects(merged[key], value);
      continue;
    }
    if (isScalarArray(merged[key]) && isScalarArray(value)) {
      merged[key] = unionScalarArrays(merged[key], value);
    }
  }
  return merged;
}

// statusLine.command 里指向任意账号投影脚本的那段路径换成规范脚本。
// 只替换路径本身，保留用户自己的解释器前缀（sh / bash / node …）。
function pointStatusLineToCanonicalScript(settings, canonicalScriptPath) {
  if (!canonicalScriptPath || !isPlainObject(settings) || !isPlainObject(settings.statusLine)) return false;
  const command = String(settings.statusLine.command || '');
  if (!command || !command.includes(STATUSLINE_SCRIPT_FILE)) return false;
  const rewritten = command.replace(/[^\s'"]*statusline-command\.sh/, canonicalScriptPath);
  if (rewritten === command) return false;
  settings.statusLine.command = rewritten;
  return true;
}

// 写之前解析真实文件：target 可能是指向规范存储的软链接，rename 会把它换成普通文件，
// 那样"一份物理文件"就断了。
function resolveWritablePath(fs, targetPath) {
  try { return fs.realpathSync(targetPath); } catch (_error) { return targetPath; }
}

function writeJsonAtomic(fs, filePath, value) {
  writeFileAtomic(fs, resolveWritablePath(fs, filePath), `${JSON.stringify(value, null, 2)}\n`);
}

function moveFile(fs, sourcePath, targetPath) {
  fs.mkdirSync(nodePath.dirname(targetPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
  }
}

/**
 * 把 sourcePath 的 settings 并进 targetPath（target 优先），并让 statusLine 指向规范脚本。
 *
 * @returns {{ changed: boolean, skipped: boolean }}
 */
function mergeSettingsFilesIntoCanonical(input = {}) {
  const fs = input.fs || nodeFs;
  const sourcePath = String(input.sourcePath || '').trim();
  const targetPath = String(input.targetPath || '').trim();
  if (!sourcePath || !targetPath) return { changed: false, skipped: true };
  const source = readJsonObject(fs, sourcePath);
  const target = readJsonObject(fs, targetPath);
  if (!source && !target) return { changed: false, skipped: true };

  // 冲突键按 mtime 定：谁最后改的算谁的。首次归一（规范那份更老）就是用账号那份；
  // 之后各账号看到的是同一个 inode，内容相同自然不会再改。App 用 rename 把链接换成
  // 普通文件时，这份新内容也比规范那份新，于是"在哪个账号改的都算"仍然成立。
  const sourceStat = statOrNull(fs, sourcePath);
  const targetStat = statOrNull(fs, targetPath);
  const preferSource = Boolean(sourceStat) && (
    !targetStat || Number(sourceStat.mtimeMs) > Number(targetStat.mtimeMs) + 1000
  );
  const merged = preferSource
    ? mergeSettingsObjects(source || {}, target || {})
    : mergeSettingsObjects(target || {}, source || {});
  const rewritten = pointStatusLineToCanonicalScript(merged, input.canonicalScriptPath);
  const changed = rewritten || JSON.stringify(merged) !== JSON.stringify(target || {});
  if (changed) writeJsonAtomic(fs, targetPath, merged);
  return { changed, skipped: false };
}

/**
 * 把 sourcePath 的**整份文件**（statusLine 脚本 / IDE argv.json）并进规范位置。
 * 规范那份不存在 → 搬过去；两份内容不同 → 取 mtime 更新的那份（"谁改的算谁的"）。
 *
 * @returns {{ changed: boolean, skipped: boolean }}
 */
function mergeStatuslineScriptIntoCanonical(input = {}) {
  const fs = input.fs || nodeFs;
  const sourcePath = String(input.sourcePath || '').trim();
  const targetPath = String(input.targetPath || '').trim();
  if (!sourcePath || !targetPath) return { changed: false, skipped: true };
  const sourceStat = statOrNull(fs, sourcePath);
  if (!sourceStat || !sourceStat.isFile()) return { changed: false, skipped: true };
  const targetStat = statOrNull(fs, targetPath);
  if (!targetStat) {
    moveFile(fs, sourcePath, targetPath);
    return { changed: true, skipped: false };
  }
  let sourceText = '';
  let targetText = '';
  try {
    sourceText = String(fs.readFileSync(sourcePath, 'utf8'));
    targetText = String(fs.readFileSync(targetPath, 'utf8'));
  } catch (_error) {
    return { changed: false, skipped: true };
  }
  if (sourceText === targetText) return { changed: false, skipped: false };
  if (Number(sourceStat.mtimeMs) <= Number(targetStat.mtimeMs)) return { changed: false, skipped: false };
  writeFileAtomic(fs, resolveWritablePath(fs, targetPath), sourceText, { mode: 0o644 });
  return { changed: true, skipped: false };
}

// WorkBuddy 桌面两支（国际 .workbuddy-ai / 国内 .workbuddy）读的是**同一套桌面
// settings schema**，但文件里混了只有本实例才知道的东西：
//   - officeFileAssociationsRepairMarker 里写着 App 路径和版本（另一个 App 用它就会
//     跳过自己的文件关联修复）；
//   - claw.users 是两个站点各自的渠道租户 id；
//   - 各种 *RepairedAt / *RanAt 只是本实例的执行记录。
// 所以两支不做整文件软链接，只把**用户配置**部分做成并集后写回两份文件：
// trustedDirectories / enabledPlugins / sandbox(extraAllowWrite + orderedRules) / skillOverrides。
const DESKTOP_SETTINGS_ROOTS = Object.freeze(['.workbuddy-ai', '.workbuddy']);
const DESKTOP_CONFIG_KEYS = Object.freeze(['trustedDirectories', 'enabledPlugins', 'sandbox', 'skillOverrides']);

function mergeOrderedRules(target, source) {
  if (!Array.isArray(target) || !Array.isArray(source)) return target;
  const merged = [...target];
  const seen = new Set(merged.map((rule) => String(rule && rule.id || JSON.stringify(rule))));
  for (const rule of source) {
    const id = String(rule && rule.id || JSON.stringify(rule));
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(rule);
  }
  return merged;
}

// base 优先（"先入为主"的那一份），other 只补缺失/并集。
function mergeDesktopConfigView(base, other) {
  const merged = { ...base };
  merged.trustedDirectories = unionScalarArrays(
    Array.isArray(base.trustedDirectories) ? base.trustedDirectories : [],
    Array.isArray(other.trustedDirectories) ? other.trustedDirectories : []
  );
  merged.enabledPlugins = mergeSettingsObjects(
    isPlainObject(base.enabledPlugins) ? base.enabledPlugins : {},
    isPlainObject(other.enabledPlugins) ? other.enabledPlugins : {}
  );
  const baseSandbox = isPlainObject(base.sandbox) ? base.sandbox : {};
  const otherSandbox = isPlainObject(other.sandbox) ? other.sandbox : {};
  const sandbox = { ...baseSandbox };
  sandbox.extraAllowWrite = unionScalarArrays(
    Array.isArray(baseSandbox.extraAllowWrite) ? baseSandbox.extraAllowWrite : [],
    Array.isArray(otherSandbox.extraAllowWrite) ? otherSandbox.extraAllowWrite : []
  );
  if (isPlainObject(baseSandbox.orderedRules) || isPlainObject(otherSandbox.orderedRules)) {
    const rules = { ...(isPlainObject(baseSandbox.orderedRules) ? baseSandbox.orderedRules : {}) };
    const otherRules = isPlainObject(otherSandbox.orderedRules) ? otherSandbox.orderedRules : {};
    for (const [kind, list] of Object.entries(otherRules)) {
      if (!isPlainObject(list)) continue;
      const current = rules[kind];
      if (!isPlainObject(current)) { rules[kind] = list; continue; }
      const next = { ...current };
      if (Array.isArray(current.rules) || Array.isArray(list.rules)) {
        next.rules = mergeOrderedRules(Array.isArray(current.rules) ? current.rules : [], Array.isArray(list.rules) ? list.rules : []);
      }
      rules[kind] = next;
    }
    sandbox.orderedRules = rules;
  }
  if (Object.keys(sandbox).length > 0) merged.sandbox = sandbox;
  const baseOverrides = isPlainObject(base.skillOverrides) ? base.skillOverrides : {};
  const otherOverrides = isPlainObject(other.skillOverrides) ? other.skillOverrides : {};
  const overrides = mergeSettingsObjects(baseOverrides, otherOverrides);
  if (Object.keys(overrides).length > 0 || 'skillOverrides' in base || 'skillOverrides' in other) {
    merged.skillOverrides = overrides;
  }
  return merged;
}

/**
 * 让 WorkBuddy 国际/国内两支桌面的**用户配置**保持一致（并集），实例状态各自保留。
 * @returns {{ changed: string[], skipped: boolean }}
 */
function syncWorkbuddyDesktopSettings(input = {}) {
  const fs = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const hostHomeDir = String(input.hostHomeDir || '').trim();
  const result = { changed: [], skipped: false };
  if (!hostHomeDir) return { ...result, skipped: true };
  const files = DESKTOP_SETTINGS_ROOTS.map((root) => pathImpl.join(hostHomeDir, root, SETTINGS_FILE));
  const [first, second] = files.map((filePath) => readJsonObject(fs, filePath));
  if (!first || !second) return { ...result, skipped: true };
  const view = mergeDesktopConfigView(first, second);
  files.forEach((filePath, index) => {
    const current = index === 0 ? first : second;
    const next = { ...current };
    let changed = false;
    for (const key of DESKTOP_CONFIG_KEYS) {
      if (!(key in view)) continue;
      if (JSON.stringify(current[key]) === JSON.stringify(view[key])) continue;
      next[key] = view[key];
      changed = true;
    }
    if (!changed) return;
    writeJsonAtomic(fs, filePath, next);
    result.changed.push(filePath);
  });
  return result;
}

/**
 * 家族**信任目录**对齐：CLI 规范存储 + WorkBuddy 两支桌面，取并集后写回所有文件。
 *
 * 为什么连桌面也要管：用户口径是"信任目录每个账号都一样"，而 CLI 与桌面各有一份
 * settings（schema 不同、不能整文件合并），信任清单是它们唯一共用的语义。并集只增不减，
 * 不会把已经信任过的目录从任何一支里抹掉。
 *
 * @returns {{ changed: string[], patterns: string[] }}
 */
function syncFamilyTrustedDirectories(input = {}) {
  const fs = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const hostHomeDir = String(input.hostHomeDir || '').trim();
  const result = { changed: [], patterns: [] };
  if (!hostHomeDir) return result;
  const targets = [
    pathImpl.join(hostHomeDir, CANONICAL_CONFIG_ROOT, SETTINGS_FILE),
    ...DESKTOP_SETTINGS_ROOTS.map((root) => pathImpl.join(hostHomeDir, root, SETTINGS_FILE))
  ];
  const entries = targets.map((filePath) => ({ filePath, settings: readJsonObject(fs, filePath) }));
  let patterns = [];
  for (const entry of entries) {
    if (!entry.settings) continue;
    patterns = unionScalarArrays(patterns, Array.isArray(entry.settings.trustedDirectories) ? entry.settings.trustedDirectories : []);
  }
  result.patterns = patterns;
  if (patterns.length === 0) return result;
  for (const entry of entries) {
    if (!entry.settings) continue;
    const current = Array.isArray(entry.settings.trustedDirectories) ? entry.settings.trustedDirectories : [];
    if (JSON.stringify(current) === JSON.stringify(patterns)) continue;
    writeJsonAtomic(fs, entry.filePath, { ...entry.settings, trustedDirectories: patterns });
    result.changed.push(entry.filePath);
  }
  return result;
}

/**
 * 把某个账号投影的 CLI 配置接到规范存储（登录/首次启动都用它，先有配置再起 CLI）。
 * @returns {{ linked: string[], merged: string[] }}
 */
function linkSharedConfigForProjection(input = {}) {
  const fs = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const configDir = String(input.configDir || '').trim();
  const hostHomeDir = String(input.hostHomeDir || '').trim();
  const result = { linked: [], merged: [] };
  if (!configDir || !hostHomeDir) return result;
  if (!isCliConfigRoot(pathImpl.basename(configDir))) return result;
  const canonicalRoot = pathImpl.join(hostHomeDir, CANONICAL_CONFIG_ROOT);
  for (const entry of CLI_SHARED_CONFIG_ENTRIES) {
    const linkPath = pathImpl.join(configDir, entry);
    const targetPath = pathImpl.join(canonicalRoot, entry);
    const info = lstatOrNull(fs, linkPath);
    if (info && info.isSymbolicLink()) continue;
    if (info && info.isFile()) {
      const merged = mergeCliSharedConfigEntry({
        fs,
        path: pathImpl,
        entryName: entry,
        sourcePath: linkPath,
        targetPath,
        canonicalScriptPath: canonicalStatuslineScriptPath(hostHomeDir, pathImpl)
      });
      if (merged.skipped || !lstatOrNull(fs, targetPath)) continue;
      if (lstatOrNull(fs, linkPath)) fs.unlinkSync(linkPath);
      result.merged.push(linkPath);
    } else if (info || !lstatOrNull(fs, targetPath)) {
      continue;
    }
    try {
      fs.symlinkSync(targetPath, linkPath, 'file');
      result.linked.push(linkPath);
    } catch (_error) { /* 并发建链失败：下一次再试 */ }
  }
  return result;
}

/**
 * 提示历史 history.jsonl：按行去重后并进规范文件（追加，不改已有内容）。
 * 不做整份覆盖：那是把别的账号的历史删掉，而不是统一。
 *
 * @returns {{ changed: boolean, skipped: boolean }}
 */
function mergePromptHistoryFile(input = {}) {
  const fs = input.fs || nodeFs;
  const sourcePath = String(input.sourcePath || '').trim();
  const targetPath = String(input.targetPath || '').trim();
  if (!sourcePath || !targetPath) return { changed: false, skipped: true };
  const sourceStat = statOrNull(fs, sourcePath);
  if (!sourceStat || !sourceStat.isFile()) return { changed: false, skipped: true };
  let sourceText = '';
  try { sourceText = String(fs.readFileSync(sourcePath, 'utf8')); } catch (_error) {
    return { changed: false, skipped: true };
  }
  const targetStat = statOrNull(fs, targetPath);
  if (!targetStat) {
    moveFile(fs, sourcePath, targetPath);
    return { changed: true, skipped: false };
  }
  const existing = new Set(
    String(fs.readFileSync(targetPath, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean)
  );
  const additions = [];
  for (const line of sourceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || existing.has(trimmed)) continue;
    existing.add(trimmed);
    additions.push(line);
  }
  if (additions.length === 0) return { changed: false, skipped: false };
  const prefix = String(fs.readFileSync(targetPath, 'utf8'));
  const separator = prefix.endsWith('\n') || prefix.length === 0 ? '' : '\n';
  writeFileAtomic(fs, resolveWritablePath(fs, targetPath), prefix + separator + additions.join('\n') + '\n');
  return { changed: true, skipped: false };
}

function mergeCliSharedConfigEntry(input = {}) {
  const entryName = String(input.entryName || '').trim();
  if (entryName === SETTINGS_FILE) return mergeSettingsFilesIntoCanonical(input);
  // 脚本与 argv.json 都是"整份文件、取新版"，不解析内容。
  if (entryName === STATUSLINE_SCRIPT_FILE || entryName === ARGV_FILE) {
    return mergeStatuslineScriptIntoCanonical(input);
  }
  return { changed: false, skipped: true };
}

module.exports = {
  SETTINGS_FILE,
  STATUSLINE_SCRIPT_FILE,
  ARGV_FILE,
  HISTORY_FILE,
  SESSION_ARTIFACT_ENTRIES,
  SKILLS_DIR,
  PLUGINS_DIR,
  mergePromptHistoryFile,
  CLI_CONFIG_ROOTS,
  CANONICAL_CONFIG_ROOT,
  CLI_SHARED_CONFIG_ENTRIES,
  canonicalStatuslineScriptPath,
  isCliConfigRoot,
  isCliSharedConfigEntry,
  linkSharedConfigForProjection,
  mergeDesktopConfigView,
  syncWorkbuddyDesktopSettings,
  syncFamilyTrustedDirectories,
  lstatOrNull,
  mergeCliSharedConfigEntry,
  mergeSettingsFilesIntoCanonical,
  mergeSettingsObjects,
  mergeStatuslineScriptIntoCanonical,
  pointStatusLineToCanonicalScript
};
