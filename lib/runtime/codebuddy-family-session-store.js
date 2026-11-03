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
const {
  CLI_SHARED_CONFIG_ENTRIES,
  HISTORY_FILE,
  PLUGINS_DIR,
  SESSION_ARTIFACT_ENTRIES,
  SKILLS_DIR,
  canonicalStatuslineScriptPath,
  isCliConfigRoot,
  isCliSharedConfigEntry,
  mergeCliSharedConfigEntry,
  mergePromptHistoryFile,
  syncFamilyTrustedDirectories,
  syncWorkbuddyDesktopSettings
} = require('./codebuddy-shared-config');

// 规范存储的配置根名。刻意选 `codebuddy` 那一支：它是国际站 CLI 的默认配置根，
// 也是 aih 早就预建、早就链接过去的那一份，不引入新路径、不新增备份/清理清单。
// 与 `getProviderStoragePolicy('codebuddy').nativeRoot` 的一致性由
// test/codebuddy-family-session-store.test.js 守卫。
const FAMILY_SESSION_STORE_CONFIG_DIR = '.codebuddy';

// 家族共享条目：会话（projects，只链接、绝不迁移）+ harness 配置（技能/指令/MCP）
// + 自定义模型目录（models.json）。
//
// models.json 是 Desktop / CLI 读的「定制模型」清单（宿主 ~/.codebuddy/models.json）。
// 不共享时每个账号投影里要么没有这份文件、要么是 CLI 自建的空壳 {"models":[]}，
// 于是 WebUI 用某个账号打开 CodeBuddy Desktop，模型列表是空的（需求第 71 条）。
// 与 mcp.json 同一机制：一份物理文件，其余全是链接；不复制、不合并、不凭空造。
// 会话产物也属于"会话只有一份"：提示历史、文件快照、计划、任务、shell 快照、附件 blob。
// 它们都是**按会话 id 分目录**的（不同账号写的是不同会话），所以运行期可以按子项并集后建链，
// 不会出现两份历史。projects（会话正文）仍然只链接、绝不搬迁。
const FAMILY_SESSION_ARTIFACT_ENTRIES = Object.freeze([...SESSION_ARTIFACT_ENTRIES]);
const FAMILY_SHARED_ENTRIES = Object.freeze([
  'projects',
  SKILLS_DIR,
  'AGENTS.md',
  'mcp.json',
  'models.json',
  ...FAMILY_SESSION_ARTIFACT_ENTRIES
]);
const SESSION_STORE_ENTRY = 'projects';

// CLI 配置条目只对 CLI 那一支的配置根生效（.codebuddy / .codebuddy-cn）。
// WorkBuddy 桌面根的 settings.json 是桌面 App 自己的配置（sandbox / claw / office
// 标记，29 KB 级），与 CLI settings 不是一个 schema —— 归一等于把桌面配置覆盖成
// 几百字节的 CLI 小 JSON。见 runtime/codebuddy-shared-config.js。
function sharedEntriesForConfigDir(configDir) {
  if (!isCliConfigRoot(configDir)) return FAMILY_SHARED_ENTRIES;
  return Object.freeze([
    ...FAMILY_SHARED_ENTRIES,
    'settings.json',
    'statusline-command.sh',
    'argv.json',
    // 插件安装体只有两个 CLI 根是同一套目录布局；WorkBuddy 桌面是另一套清单文件，
    // 混在一起会让两边的插件管理器互相看到不认识的目录。
    PLUGINS_DIR
  ]);
}

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
    // ENOTDIR：路径中间某段是文件（例如账号目录旁边混进 .DS_Store），等价于"这里没有"。
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
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
function createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, isDirectory) {
  fs.mkdirSync(pathImpl.dirname(linkPath), { recursive: true });
  const temporary = `${linkPath}.aih-link-${suffix}`;
  try { fs.unlinkSync(temporary); } catch (_error) { /* 上一轮的残留，忽略 */ }
  // Windows 的 junction 只能指目录；文件条目（AGENTS.md / mcp.json / models.json）必须用
  // 'file'，否则建链直接失败。POSIX 上 type 参数被忽略，目录/文件都用 'dir' 无害。
  const type = platform === 'win32' ? (isDirectory === false ? 'file' : 'junction') : 'dir';
  fs.symlinkSync(targetPath, temporary, type);
  fs.renameSync(temporary, linkPath);
}

function isDirectoryEmpty(fs, dirPath) {
  try { return fs.readdirSync(dirPath).length === 0; } catch (_error) { return false; }
}

// 空模型清单与空目录同义：CLI 首启会在配置根里自建 models.json（实测有 [] 与
// {"models":[]} 两种空壳）。它不含任何用户数据，留着就会让该配置根的账号永远
// 显示「没有可用模型」，所以允许像空目录一样换成指向规范存储的链接。
// 只对 models.json 生效，且只认「解析后没有任何条目」——有内容一律不动。
function isEmptyModelCatalogFile(fs, pathImpl, filePath) {
  if (pathImpl.basename(filePath) !== 'models.json') return false;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > 4096) return false;
    const text = String(fs.readFileSync(filePath, 'utf8') || '').trim();
    if (!text) return true;
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (!parsed || typeof parsed !== 'object') return false;
    if (Array.isArray(parsed.models)) return parsed.models.length === 0;
    return Object.keys(parsed).length === 0;
  } catch (_error) {
    return false;
  }
}

// CLI 配置（settings.json / statusline 脚本）在某个配置根里还是**真实文件**时，
// 不能像会话目录那样一律报 unresolved —— 用户要的是"一份配置"，放任各根各存一份
// 就永远归一不了。这里把内容并进规范存储（同样的键按 mtime 定先后，谁后改算谁的），
// 再把它换成链接。
function adoptSharedConfigFile(fs, pathImpl, platform, linkPath, targetPath, suffix, entryName, hostHomeDir, result) {
  const merged = mergeCliSharedConfigEntry({
    fs,
    path: pathImpl,
    entryName,
    sourcePath: linkPath,
    targetPath,
    canonicalScriptPath: canonicalStatuslineScriptPath(hostHomeDir, pathImpl)
  });
  if (merged.skipped || !lstatOrNull(fs, targetPath)) {
    result.unresolved.push(linkPath);
    return;
  }
  // 脚本条目在规范那份缺失时是"搬过去"，源文件此时已经不存在了。
  if (lstatOrNull(fs, linkPath)) fs.unlinkSync(linkPath);
  createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, false);
  result.linked.push(linkPath);
}

// 会话产物（file-history/plans/tasks/shell-snapshots/blobs/skills）：按**子项**并集后建链。
// 每个子项都是某个会话自己的目录（或某个技能实体），不同账号写的是不同子项，
// 运行期搬走别人的子项不会发生——所以这里可以安全地 moved-and-linked。
// 同名的子项一律保留规范存储那份（绝不覆盖、绝不复制），需要人工比对时才报 unresolved。
function mergeDirectoryUnion(fs, pathImpl, sourceDir, storeDir, state) {
  let names = [];
  try { names = fs.readdirSync(sourceDir); } catch (error) {
    if (error && error.code === 'ENOENT') return; // 并发下已被另一个进程搬空
    throw error;
  }
  fs.mkdirSync(storeDir, { recursive: true });
  for (const name of names) {
    const sourcePath = pathImpl.join(sourceDir, name);
    if (name === '.DS_Store') {
      try { fs.unlinkSync(sourcePath); } catch (_error) { /* 忽略 */ }
      continue;
    }
    const storePath = pathImpl.join(storeDir, name);
    const sourceInfo = lstatOrNull(fs, sourcePath);
    if (!sourceInfo) continue;
    // 已经指向规范存储的链接（技能实体常见形态）：它就是同一份东西，直接去重。
    if (sourceInfo.isSymbolicLink()) {
      try {
        const resolved = pathImpl.resolve(pathImpl.dirname(sourcePath), fs.readlinkSync(sourcePath));
        if (resolved.startsWith(pathImpl.resolve(storeDir) + pathImpl.sep)) {
          fs.unlinkSync(sourcePath);
          continue;
        }
      } catch (_error) { /* 读不了就按冲突处理 */ }
    }
    const storeInfo = lstatOrNull(fs, storePath);
    if (!storeInfo) {
      try {
        fs.renameSync(sourcePath, storePath);
      } catch (error) {
        // 并发启动时另一个进程可能刚把它搬走：ENOENT 视为"已被搬走"，不报错。
        if (error && error.code === 'ENOENT') continue;
        // 跨设备时绝不退化成 copy（会话历史会出现第二份）。留着，交给人工。
        if (error && error.code === 'EXDEV') { state.crossDevice = true; return; }
        throw error;
      }
      continue;
    }
    if (sourceInfo.isDirectory() && storeInfo.isDirectory()) {
      mergeDirectoryUnion(fs, pathImpl, sourcePath, storePath, state);
      if (state.crossDevice) return;
      try {
        if (fs.readdirSync(sourcePath).length === 0) fs.rmdirSync(sourcePath);
      } catch (_error) { /* 忽略 */ }
      continue;
    }
    // 同名文件：内容一致（或来源是空壳标记）就直接丢掉来源，规范那份就是它；
    // 内容不同才保留来源、最后整体报 unresolved（绝不覆盖、绝不复制）。
    if (!sourceInfo.isDirectory() && !storeInfo.isDirectory()) {
      try {
        const sourceSize = Number(sourceInfo.size) || 0;
        const storeSize = Number(storeInfo.size) || 0;
        if (sourceSize === 0 || (sourceSize === storeSize && sourceSize <= 4 * 1024 * 1024
          && Buffer.compare(fs.readFileSync(sourcePath), fs.readFileSync(storePath)) === 0)) {
          fs.unlinkSync(sourcePath);
        }
      } catch (_error) { /* 读不了就按冲突处理 */ }
    }
  }
}

function adoptSessionArtifactDir(fs, pathImpl, platform, linkPath, targetPath, suffix, result) {
  const state = { crossDevice: false };
  mergeDirectoryUnion(fs, pathImpl, linkPath, targetPath, state);
  if (state.crossDevice) {
    result.unresolved.push(linkPath);
    return;
  }
  // skills 目录里剩下的通常是 App 自己的迁移标记（点文件）。它们不是技能实体，
  // 但会让整目录永远无法建链：挪进规范存储，同名冲突时给来源加后缀保留（改名不删数据）。
  if (pathImpl.basename(linkPath) === SKILLS_DIR) {
    let names = [];
    try { names = fs.readdirSync(linkPath); } catch (error) {
      if (error && error.code === 'ENOENT') return; // 并发下已建好链接
      throw error;
    }
    const leftovers = names.filter((name) => name !== '.DS_Store' && name.startsWith('.'));
    const others = names.filter((name) => name !== '.DS_Store' && !name.startsWith('.'));
    if (others.length === 0) {
      const suffixTag = pathImpl.basename(pathImpl.dirname(linkPath));
      for (const name of leftovers) {
        const sourcePath = pathImpl.join(linkPath, name);
        let storePath = pathImpl.join(targetPath, name);
        if (lstatOrNull(fs, storePath)) storePath = pathImpl.join(targetPath, `${name}.${suffixTag}`);
        if (lstatOrNull(fs, storePath)) {
          // 副档也在了（上一轮搬过，或 App 又把链接换回真实目录）：取新的一份覆盖副档，
          // 再删来源。这样重复执行会收敛，不会卡在 unresolved，也不会长出第三份。
          try {
            const sourceInfo = fs.lstatSync(sourcePath);
            const storeInfo = fs.lstatSync(storePath);
            if (Number(sourceInfo.mtimeMs) > Number(storeInfo.mtimeMs)) {
              fs.writeFileSync(storePath, fs.readFileSync(sourcePath));
            }
            fs.unlinkSync(sourcePath);
          } catch (_error) { /* 留着，等下报 unresolved */ }
          continue;
        }
        try { fs.renameSync(sourcePath, storePath); } catch (_error) { /* 留着，等下报 unresolved */ }
      }
    }
  }
  let remaining = [];
  try { remaining = fs.readdirSync(linkPath).filter((name) => name !== '.DS_Store'); } catch (error) {
    if (error && error.code === 'ENOENT') return; // 另一个进程已经建好链接
    throw error;
  }
  if (remaining.length > 0) {
    result.unresolved.push(linkPath);
    return;
  }
  try { fs.rmdirSync(linkPath); } catch (error) {
    // 并发下可能已被别的进程换成链接（ENOTDIR）或删掉（ENOENT）。
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'ENOTEMPTY')) throw error;
  }
  createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, true);
  result.linked.push(linkPath);
}

function linkSharedEntry(fs, pathImpl, platform, linkPath, targetPath, suffix, result, context = {}) {
  const info = lstatOrNull(fs, linkPath);
  const entryName = String(context.entryName || pathImpl.basename(linkPath));
  // 提示历史是追加型文件：按行去重后并入规范文件，再换成链接。
  if (info && entryName === HISTORY_FILE && info.isFile() && !info.isSymbolicLink()) {
    const merged = mergePromptHistoryFile({ fs, path: pathImpl, sourcePath: linkPath, targetPath });
    if (merged.skipped || !lstatOrNull(fs, targetPath)) {
      result.unresolved.push(linkPath);
      return;
    }
    if (lstatOrNull(fs, linkPath)) fs.unlinkSync(linkPath);
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, false);
    result.linked.push(linkPath);
    return;
  }
  // 会话产物目录：子项并集后建链（skills 同理，实体只留一份）。
  // plugins 只在两个 CLI 根之间并集（WorkBuddy 桌面是另一套插件清单布局）。
  const configDirName = pathImpl.basename(pathImpl.dirname(linkPath));
  const adoptableDir = FAMILY_SESSION_ARTIFACT_ENTRIES.includes(entryName)
    || entryName === SKILLS_DIR
    || (entryName === PLUGINS_DIR && isCliConfigRoot(configDirName));
  if (info && info.isDirectory() && !info.isSymbolicLink() && adoptableDir) {
    adoptSessionArtifactDir(fs, pathImpl, platform, linkPath, targetPath, suffix, result);
    return;
  }
  if (info && isCliSharedConfigEntry(entryName) && info.isFile() && !info.isSymbolicLink()) {
    adoptSharedConfigFile(fs, pathImpl, platform, linkPath, targetPath, suffix, entryName, context.hostHomeDir, result);
    return;
  }
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
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, targetStat.isDirectory());
    result.linked.push(linkPath);
    return;
  }

  if (info.isDirectory() && isDirectoryEmpty(fs, linkPath)) {
    fs.rmdirSync(linkPath);
    if (!targetStat) fs.mkdirSync(targetPath, { recursive: true });
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, true);
    result.linked.push(linkPath);
    return;
  }

  // 空清单（CLI 自建的空壳）没有数据可保护：换成指向规范存储的链接。
  // 规范存储那份还不存在时不动——不凭空造，等宿主出现再链接。
  if (targetStat && isEmptyModelCatalogFile(fs, pathImpl, linkPath)) {
    fs.unlinkSync(linkPath);
    createLinkAtomically(fs, pathImpl, platform, linkPath, targetPath, suffix, targetStat.isDirectory());
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
    for (const entry of sharedEntriesForConfigDir(root.configDir)) {
      const linkPath = pathImpl.join(hostHomeDir, root.configDir, entry);
      const targetPath = pathImpl.join(canonicalRoot, entry);
      try {
        linkSharedEntry(fs, pathImpl, platform, linkPath, targetPath, suffix, result, {
          entryName: entry,
          hostHomeDir
        });
      } catch (error) {
        result.failed.push({ path: linkPath, error: String((error && (error.code || error.message)) || error) });
      }
    }
  }

  // WorkBuddy 国内/国际两支桌面读同一套 settings schema，但整文件归一会把 App 路径
  // 标记和渠道租户 id 混在一起；这里只把**用户配置**（信任目录 / 插件 / 沙箱白名单 /
  // 技能覆盖）做并集写回两份文件，实例状态各自保留。
  try {
    const desktop = syncWorkbuddyDesktopSettings({ fs, path: pathImpl, hostHomeDir });
    if (desktop.changed.length > 0) result.desktopSettingsSynced = desktop.changed;
  } catch (error) {
    result.failed.push({ path: 'workbuddy-desktop-settings', error: String((error && (error.code || error.message)) || error) });
  }

  // 信任目录：CLI 规范存储与两支桌面取并集后写回，三处完全一致（用户口径：
  // 信任目录每个账号都一样，不要每台客户端各问一遍）。
  try {
    const trust = syncFamilyTrustedDirectories({ fs, path: pathImpl, hostHomeDir });
    if (trust.changed.length > 0) result.trustSynced = trust.changed;
  } catch (error) {
    result.failed.push({ path: 'family-trusted-directories', error: String((error && (error.code || error.message)) || error) });
  }

  // 账号投影里的 CLI 配置被 App 的原子写换成了普通文件（rename 顶掉软链接）时，
  // 它就在规范存储之外孤零零存了一份。任意账号启动都顺手把这类孤儿并回去，
  // 于是"在 A 账号改的配置"不必等 A 下次启动，B 一启动就能看到。
  healSharedCliConfigInProjections(fs, pathImpl, platform, {
    hostHomeDir,
    aiHomeDir: options.aiHomeDir,
    suffix,
    result
  });

  return result;
}

function healSharedCliConfigInProjections(fs, pathImpl, platform, options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!hostHomeDir) return;
  const result = options.result;
  const canonicalRoot = pathImpl.join(hostHomeDir, FAMILY_SESSION_STORE_CONFIG_DIR);
  for (const provider of FAMILY_PROVIDERS) {
    const configDir = familyConfigDirName(provider);
    if (!isCliConfigRoot(configDir)) continue;
    const providerRoot = pathImpl.join(aiHomeDir, 'run', 'auth-projections', provider);
    // 只认真实的账号目录：provider 根下可能混着 .DS_Store 这类文件。
    let accounts = [];
    try {
      accounts = fs.readdirSync(providerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch (_error) { continue; }
    for (const accountRef of accounts) {
      for (const entry of CLI_SHARED_CONFIG_ENTRIES) {
        const linkPath = pathImpl.join(providerRoot, accountRef, configDir, entry);
        const info = lstatOrNull(fs, linkPath);
        if (!info || info.isSymbolicLink() || !info.isFile()) continue;
        try {
          adoptSharedConfigFile(
            fs, pathImpl, platform, linkPath,
            pathImpl.join(canonicalRoot, entry), options.suffix, entry, hostHomeDir, result
          );
        } catch (error) {
          result.failed.push({ path: linkPath, error: String((error && (error.code || error.message)) || error) });
        }
      }
    }
  }
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
