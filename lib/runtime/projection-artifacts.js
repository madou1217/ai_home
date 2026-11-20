'use strict';

/**
 * 账号投影的共享构件准备（shared artifact preparation for account projections）。
 *
 * 一句话职责：**在拉起任何账号之前**，把「可再生、跨账号完全相同」的东西收敛成一份，
 * 并回收已经堆积的旧版本/日志。这是 aih 启动路径的职责，不是用户手工清理的职责。
 *
 * 三件事，按"先建共享、再回收"的顺序：
 *   1. `linkSharedHostCaches`（既有）——环境变量覆盖不到的固定缓存路径（macOS 的
 *      `Library/Caches/*`）建符号链接到宿主那一份。
 *   2. CLI 版本树共享 —— 同一 (cli, 版本) 在所有账号里只保留一份物理内容。
 *   3. 回收 —— 旧版本、过期日志/追踪按保留策略删除，永不动在用的与账号私有数据。
 *
 * 共享方式的**策略**（不同机器能力不同，不能写死 clonefile）：
 *   `reflink`（APFS clonefile / btrfs·XFS FICLONE）→ 每账号独立文件身份、共享磁盘块，
 *   安装器原地改写只影响自己；
 *   `hardlink`（同卷、无 reflink）→ 共享 inode，但构件在库里是只读 0444/0555，
 *   原地写会 EACCES，安装器只能 unlink+rename，因此不会污染别的账号；
 *   `symlink`（目录；Windows 用 junction）→ 真正只有一份，最省，但安装器原地写会穿透；
 *   `copy` → 兜底，交给回收策略兜住体积。
 *
 * 能力探测结果做进程内缓存（同一卷只探测一次）。所有失败都只记录不抛出：构件共享是
 * 启动路径上的增强，绝不能因为共享失败而让账号起不来。
 */

const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { linkSharedHostCaches } = require('./shared-host-caches');
// 版本构件的"事实"在 version-artifacts（共享与回收的共同下层，避免两者互相依赖）。
const {
  VERSION_ROOTS,
  compareVersions,
  ensureDirectoryWritable,
  listVersionArtifacts,
  makeTreeRemovable,
  makeWritable
} = require('./version-artifacts');
const { emptyTrash, pruneLogs, pruneStoreTrees, pruneVersions } = require('./artifact-gc');

/** 默认保留策略：当前 + 上一版；超期日志清理。 */
const DEFAULT_RETENTION = Object.freeze({
  keepVersions: 2,
  logMaxAgeDays: 14,
  trashGraceDays: 7,
  // 回收要跑 ps/lsof（几百毫秒），不能每次启动都做；共享本身仍然每次对账。
  gcIntervalHours: 6,
  logDirNames: Object.freeze(['traces', 'logs']),
  logParents: Object.freeze(['.codebuddy-cn', '.codebuddy', '.workbuddy-ai', '.workbuddy', '.qoder', '.qoder-cn'])
});

const reflinkCapability = new Map();

function normalizePlatform(platform) {
  return String(platform || process.platform || '').toLowerCase();
}

/**
 * 目标目录所在卷是否真的支持 reflink（写时复制共享磁盘块）。
 *
 * 不能只看命令是否成功：Node 的 `COPYFILE_FICLONE` 在不支持的文件系统上会**静默退化成
 * 真复制**，`COPYFILE_FICLONE_FORCE` 在 APFS 上也常返回失败（实测 macOS 14 + Node 22）。
 * 因此这里做**块级实测**：写一个探测文件、记录分区可用空间、用平台原生克隆命令复制一份，
 * 只有"可用空间没有按文件大小下降"才判定支持。
 *
 * 平台口径：darwin 用 `cp -c`（clonefile）；linux 用 `cp --reflink=always`（不支持会退出非 0）；
 * win32 默认不支持（ReFS 块克隆需要 Server 版）。
 */
function supportsReflink(directory, fs, deps = {}) {
  // 缓存必须带平台：同一目录在"本机 darwin"和"模拟 win32/linux"下结论不同。
  const key = `${normalizePlatform(deps.platform)}:${directory}`;
  if (reflinkCapability.has(key)) return reflinkCapability.get(key);
  const probe = deps.reflinkProbe;
  if (typeof probe === 'function') {
    const result = Boolean(probe(directory));
    reflinkCapability.set(key, result);
    return result;
  }
  const platform = normalizePlatform(deps.platform);
  let supported = false;
  if (platform !== 'win32' && typeof fs.statfsSync === 'function') {
    // 探针要足够大：卷上同时在写（其他会话构建、Spotlight）时，8MB 文件的可用空间
    // 波动会超过 1/4 容差，导致 APFS 被误判为"不支持 reflink"而退成硬链接。
    // 用 32MB + 两次取最优，噪声容差 1/2。
    const probeBytes = 32 * 1024 * 1024;
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const source = nodePath.join(directory, `.aih-reflink-probe-${stamp}-src`);
    const clone = nodePath.join(directory, `.aih-reflink-probe-${stamp}-dst`);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(source, Buffer.alloc(probeBytes, 7));
      const command = platform === 'darwin'
        ? ['cp', ['-c', source, clone]]
        : ['cp', ['--reflink=always', source, clone]];
      const exec = deps.execFileSync || require('node:child_process').execFileSync;
      for (let attempt = 0; attempt < 2 && !supported; attempt += 1) {
        const before = freeBytes(fs, directory);
        try {
          exec(command[0], command[1], { stdio: 'ignore' });
        } catch (_error) {
          continue; // 该平台/卷不支持 clone；换下一次也不会成功，但保持结构简单
        }
        const after = freeBytes(fs, directory);
        // 真复制会让可用空间下降约一个文件大小；共享块时基本不变。
        supported = before > 0 && after > 0 && (before - after) < probeBytes / 2;
        if (!supported) {
          try { fs.unlinkSync(clone); } catch (_error) { /* 下一轮重建 */ }
        }
      }
    } catch (_error) {
      supported = false;
    } finally {
      try { fs.unlinkSync(source); } catch (_error) { /* 探测残留清理失败不影响判定 */ }
      try { fs.unlinkSync(clone); } catch (_error) { /* 同上 */ }
    }
  }
  reflinkCapability.set(key, supported);
  return supported;
}

function freeBytes(fs, directory) {
  try {
    const info = fs.statfsSync(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch (_error) {
    return 0;
  }
}

/** 探测结果复位（策略变化或测试用）。 */
function resetReflinkProbeCache() {
  reflinkCapability.clear();
}

/**
 * 平台原生 clonefile / reflink 复制（目录或单文件）。
 *
 * 必须用原生命令：Node 的 `COPYFILE_FICLONE` 在失败时会静默退化成真复制，
 * 那样"共享"实际不存在，只是白跑一趟。
 */
function cloneViaPlatform(source, target, platform, deps = {}) {
  const exec = deps.execFileSync || require('node:child_process').execFileSync;
  const targetPlatform = normalizePlatform(platform);
  let isDirectory = false;
  try { isDirectory = (deps.fs || nodeFs).lstatSync(source).isDirectory(); } catch (_error) { isDirectory = false; }
  // 目录必须带 -R，否则 cp 直接报 "is a directory"，会被误当成"该卷不支持 clone"。
  const recursive = isDirectory ? ['-R'] : [];
  if (targetPlatform === 'darwin') {
    exec('cp', ['-c', ...recursive, source, target], { stdio: 'ignore' });
    return;
  }
  if (targetPlatform === 'linux') {
    exec('cp', ['--reflink=always', ...recursive, source, target], { stdio: 'ignore' });
    return;
  }
  // 其它平台没有可靠的块级克隆原语：交给调用方退一级策略。
  throw new Error('reflink_unsupported_platform');
}

/** 距上次回收是否已超过间隔（没有记录 = 该跑）。 */
function shouldRunGc(fs, storeRoot, intervalHours) {
  if (!(intervalHours > 0)) return true;
  try {
    const info = fs.statSync(nodePath.join(storeRoot, '.last-gc'));
    return Date.now() - Number(info.mtimeMs) >= intervalHours * 60 * 60 * 1000;
  } catch (_error) { return true; }
}

function markGcRan(fs, storeRoot) {
  try { fs.writeFileSync(nodePath.join(storeRoot, '.last-gc'), new Date().toISOString() + '\n'); } catch (_error) { /* noop */ }
}

/**
 * 直接在目标位置建目录树 + 硬链接（不先复制）。
 *
 * 之前是 cpSync 后再逐文件 unlink+link；在 ext4 上 cpSync 会保留库内 0555 目录权限，
 * unlink 直接 EACCES，链接静默失败，最终每个账号仍是一份真实副本（实测 3 个账号
 * 只有最后一个成功）。现在目录自己建、文件直接 link，符号链接原样复制。
 */
function linkTree(fs, source, target) {
  fs.mkdirSync(target, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch (_error) { return; }
  for (const entry of entries) {
    const from = nodePath.join(source, entry.name);
    const to = nodePath.join(target, entry.name);
    try {
      if (entry.isDirectory()) {
        linkTree(fs, from, to);
      } else if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } else if (entry.isFile()) {
        fs.linkSync(from, to);
      }
    } catch (_error) {
      // 单个条目失败时退回复制，保证账号可用；空间优化不因个别文件中断。
      try {
        const info = fs.lstatSync(from);
        if (info.isDirectory()) fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        else if (info.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
        else fs.copyFileSync(from, to);
      } catch (_copyError) { /* 交给后续可用性检查 */ }
    }
  }
}

/**
 * 构件库里的树一律只读：让"原地写"变成 EACCES，强逼安装器走 unlink+rename。
 *
 * **必须保留可执行位**：CLI 本体就是可执行文件，统一压成 0444 会直接把账号弄坏
 * （实测 `permission denied: ./codebuddy`）。规则：目录 0555；文件按原权限保留
 * 执行位——原本可执行用 0555，否则 0444。
 */
function freezeTree(fs, root) {
  const walk = (directory) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return; }
    for (const entry of entries) {
      const target = nodePath.join(directory, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(target);
          fs.chmodSync(target, 0o555);
        } else if (entry.isFile()) {
          const mode = fs.lstatSync(target).mode;
          fs.chmodSync(target, (mode & 0o111) !== 0 ? 0o555 : 0o444);
        }
      } catch (_error) { /* 只读化失败不阻塞共享 */ }
    }
  };
  walk(root);
  try { fs.chmodSync(root, 0o555); } catch (_error) { /* 同上 */ }
}

/**
 * 树的内容指纹（路径 + 大小 + 权限位；符号链接记目标）。
 *
 * 只做元数据遍历，不读文件内容——版本树动辄几百 MB，读内容会让每次启动都变慢。
 * 用途是**幂等**：投影里已经是同一份内容时不要每次启动都重新克隆/重链一遍。
 * 权限位参与指纹，因此"被解冻/被改写"也能识别出来。
 */
function fingerprintTree(fs, root) {
  const hash = nodeCrypto.createHash('sha256');
  let rootInfo = null;
  try { rootInfo = fs.lstatSync(root); } catch (_error) { return ''; }
  if (!rootInfo.isDirectory()) {
    if (rootInfo.isSymbolicLink()) return '';
    hash.update('f::' + Number(rootInfo.size) + '\n');
    return hash.digest('hex');
  }
  const walk = (directory, relative) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return false; }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      const absolute = nodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(absolute); } catch (_error) { target = '?'; }
        hash.update('l:' + rel + ':' + target + '\n');
        continue;
      }
      if (entry.isDirectory()) {
        hash.update('d:' + rel + '\n');
        if (!walk(absolute, rel)) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = fs.lstatSync(absolute);
        // 不把权限位算进指纹：库内树被冻结成 0555/0444 是正常状态，而安装器刚写的
        // 同一内容是可写的 0755。把 mode 算进去会让每个账号都触发一次"库内刷新"，
        // 反而把先前账号的共享链接孤立掉（实测 ext4 上 3 个账号只有最后一个共享）。
        hash.update('f:' + rel + ':' + Number(info.size) + '\n');
      } catch (_error) { return false; }
    }
    return true;
  };
  if (!walk(root, '')) return '';
  return hash.digest('hex');
}

/**
 * 投影的"已安装"账本：记录每个 (cli,version) 是我们铺的这一份对象（dev+ino）。
 *
 * 为什么需要它：reflink 克隆与普通复制在元数据上完全一样（各自的 inode、同样的只读位），
 * 仅凭"只读 + 内容指纹相同"无法区分——会把一份独立的真实副本误判成已共享（实测
 * 5 个账号仍占 5 份字节）。账本记录"这个 inode 是我们创建的"，安装器一旦 rename 换掉
 * inode 就对不上，下次启动自然重新共享。放在库内，不污染账号目录。
 */
function ledgerPathFor(storeRoot, projectionPath) {
  const digest = nodeCrypto.createHash('sha256').update(nodePath.resolve(projectionPath)).digest('hex').slice(0, 16);
  return nodePath.join(storeRoot, 'ledger', digest + '.json');
}

function readLedger(fs, ledgerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    return parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch (_error) {
    return { entries: {} };
  }
}

function writeLedger(fs, ledgerPath, ledger) {
  try {
    fs.mkdirSync(nodePath.dirname(ledgerPath), { recursive: true });
    const temporary = ledgerPath + '.tmp-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n');
    fs.renameSync(temporary, ledgerPath);
  } catch (_error) { /* 账本只是优化：写不进去就下次重新共享 */ }
}

function ledgerKey(cli, version) {
  return cli + '@' + version;
}

/**
 * 文件身份用 **BigInt** 读取并存成字符串。
 * Windows 的 NTFS File ID 是 64 位，超过 Number 的安全整数范围；用 Number 会丢低位，
 * 重装后的新对象可能被判成"同一个 inode"而跳过共享。
 */
function statIdentity(fs, target) {
  try {
    const info = fs.lstatSync(target, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  } catch (_error) { return null; }
}

function recordShare(fs, ledgerPath, projectionPath, cli, version, storeKey, fingerprint) {
  const ledger = readLedger(fs, ledgerPath);
  const identity = statIdentity(fs, projectionPath);
  if (!identity) return;
  ledger.projectionRoot = nodePath.dirname(nodePath.dirname(projectionPath));
  ledger.entries[ledgerKey(cli, version)] = {
    storeKey,
    dev: identity.dev,
    ino: identity.ino,
    fingerprint,
    recordedAt: new Date().toISOString()
  };
  writeLedger(fs, ledgerPath, ledger);
}

function readFingerprint(fs, manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '';
  } catch (_error) { return ''; }
}

function writeFingerprint(fs, manifestPath, fingerprint) {
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({ fingerprint, recordedAt: new Date().toISOString() }) + '\n');
  } catch (_error) { /* 指纹只是优化：写不进去就每次重新对齐 */ }
}

/** 只读挂载的根目录说明这份树是我们铺的（安装器自己装出来的不会是 0555）。 */
function isFrozenRoot(fs, target) {
  try { return (Number(fs.lstatSync(target).mode) & 0o200) === 0; } catch (_error) { return false; }
}

function isSymlink(fs, target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch (_error) { return false; }
}

function exists(fs, target) {
  try { fs.lstatSync(target); return true; } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function readlinkTarget(fs, linkPath) {
  try { return nodePath.resolve(nodePath.dirname(linkPath), fs.readlinkSync(linkPath)); } catch (_error) { return ''; }
}

/** 原子替换：先建临时链接/目录，再 rename 到位，避免中途被读到半个状态。 */
function atomicReplace(fs, target, build) {
  const parent = nodePath.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = nodePath.join(parent, `.${nodePath.basename(target)}.aih-tmp-${process.pid}-${Date.now()}`);
  try {
    build(temporary);
    if (exists(fs, target)) {
      const backup = `${temporary}.old`;
      // 只读树必须先放开目录写权限，否则 macOS 上 rename 自身就 EACCES。
      makeTreeRemovable(fs, target);
      fs.renameSync(target, backup);
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.renameSync(backup, target); } catch (_error) { /* 回滚失败只能上报 */ }
        throw error;
      }
      try { makeWritable(fs, backup); fs.rmSync(backup, { recursive: true, force: true }); } catch (_error) { /* noop */ }
    } else {
      fs.renameSync(temporary, target);
    }
  } finally {
    try { makeWritable(fs, temporary); fs.rmSync(temporary, { recursive: true, force: true }); } catch (_error) { /* noop */ }
  }
}

/**
 * 决定某个 (platform, 卷) 下版本构件的共享方式。
 * 顺序即安全性：独立身份优先，只读硬链接次之，符号链接再次，最后各自一份。
 */
function resolveShareStrategy({ platform, directory, fs, deps }) {
  // 探测必须使用同一个平台口径；否则在非本机平台上会拿宿主平台的结果做决策。
  if (supportsReflink(directory, fs, { ...(deps || {}), platform })) return 'reflink';
  if (typeof fs.linkSync === 'function') return 'hardlink';
  if (normalizePlatform(platform) === 'win32') return 'junction';
  return 'symlink';
}

function treeKey(provider, cli, version, platform) {
  return [provider, cli, version, normalizePlatform(platform)].join('__').replace(/[^A-Za-z0-9_.@-]+/g, '_');
}

/** 把投影里的那份搬进构件库：暂存 → 冻结 → 原子改名。 */
function materializeStoreTree({ fs, projectionPath, storePath, storeRoot }) {
  const treesDir = nodePath.join(storeRoot, 'trees');
  ensureDirectoryWritable(fs, treesDir); // 库根必须可写，否则暂存目录建不出来
  const staging = nodePath.join(treesDir, '.' + nodePath.basename(storePath) + '.staging-' + process.pid + '-' + Date.now());
  try {
    const stat = fs.lstatSync(projectionPath);
    if (stat.isDirectory()) {
      fs.cpSync(projectionPath, staging, {
        recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true
      });
      freezeTree(fs, staging);
    } else {
      fs.copyFileSync(projectionPath, staging);
      try { fs.chmodSync(staging, 0o444); } catch (_error) { /* noop */ }
    }
    fs.renameSync(staging, storePath);
  } catch (error) {
    try { makeWritable(fs, staging); fs.rmSync(staging, { recursive: true, force: true }); } catch (_error) { /* noop */ }
    // 并发安装或权限问题：库里已有就用库里的，否则把错误交给调用方记录。
    if (!exists(fs, storePath)) throw error;
  }
}

/**
 * 同一个版本号的内容变了（官方安装器重装/修复）：以投影为准刷新库内树。
 * 旧树先从库里摘名再删除，投影自己的副本/硬链接不受影响。
 */
function refreshStoreTree({ fs, projectionPath, storePath, storeRoot }) {
  const aside = storePath + '.stale-' + process.pid + '-' + Date.now();
  makeTreeRemovable(fs, storePath);
  try { fs.renameSync(storePath, aside); } catch (_error) { return false; }
  try {
    materializeStoreTree({ fs, projectionPath, storePath, storeRoot });
  } finally {
    try { makeWritable(fs, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch (_error) { /* noop */ }
  }
  return true;
}

/**
 * 把投影里的一个版本构件并入构件库，并按策略共享。
 * @returns {{action: string, strategy: string, storePath: string}}
 */
function shareVersionArtifact(options) {
  const {
    fs = nodeFs,
    provider,
    cli,
    version,
    projectionPath,
    storeRoot,
    platform,
    deps = {}
  } = options;
  const strategy = resolveShareStrategy({ platform, directory: storeRoot, fs, deps });
  const key = treeKey(provider, cli, version, platform);
  const storePath = nodePath.join(storeRoot, 'trees', key);
  const manifestPath = nodePath.join(storeRoot, 'trees', '.' + nodePath.basename(storePath) + '.fingerprint.json');
  const ledgerPath = ledgerPathFor(storeRoot, projectionPath);

  const alreadyLinked = isSymlink(fs, projectionPath)
    && readlinkTarget(fs, projectionPath) === nodePath.resolve(storePath);
  if (alreadyLinked) {
    const storedFingerprint = readFingerprint(fs, manifestPath) || fingerprintTree(fs, storePath);
    recordShare(fs, ledgerPath, projectionPath, cli, version, key, storedFingerprint);
    return { action: 'unchanged', strategy: 'symlink', storePath };
  }

  // 幂等：只有"账本里记录的 dev+ino 仍是投影当前对象"才算已经铺过。
  // 不能用"只读 + 指纹相同"判断：普通复制与 reflink 克隆在元数据上无法区分。
  if (exists(fs, projectionPath) && exists(fs, storePath)) {
    const entry = readLedger(fs, ledgerPath).entries[ledgerKey(cli, version)];
    if (entry && entry.storeKey === key) {
      const identity = statIdentity(fs, projectionPath);
      // inode 会被复用：安装器重装到同一路径可能拿到同一个 inode。只有仍是我们
      // 冻结的树才算 unchanged；可写副本必须重新核对内容/重新共享。
      if (identity && identity.dev === String(entry.dev) && identity.ino === String(entry.ino)
        && isFrozenRoot(fs, projectionPath)) {
        return { action: 'unchanged', strategy, storePath };
      }
    }
  }

  // 1) 库内没有这份内容：把投影里那份搬进来。
  //    已有内容但投影是"安装器刚写的可写树"且内容不同 → 以投影为准刷新库。
  if (!exists(fs, storePath)) {
    materializeStoreTree({ fs, projectionPath, storePath, storeRoot });
  } else if (exists(fs, projectionPath) && !isFrozenRoot(fs, projectionPath)) {
    const storedFingerprint = readFingerprint(fs, manifestPath) || fingerprintTree(fs, storePath);
    const projectionFingerprint = fingerprintTree(fs, projectionPath);
    if (storedFingerprint && projectionFingerprint && storedFingerprint !== projectionFingerprint) {
      if (refreshStoreTree({ fs, projectionPath, storePath, storeRoot })) {
        try { fs.rmSync(manifestPath, { force: true }); } catch (_error) { /* 重写时覆盖 */ }
      }
    }
  }

  // 库内指纹只算一次：后续每次启动拿它和投影比对即可，不必重新遍历库内树。
  if (!readFingerprint(fs, manifestPath)) {
    const fingerprint = fingerprintTree(fs, storePath);
    if (fingerprint) writeFingerprint(fs, manifestPath, fingerprint);
  }

  // 2) 从库里按策略铺回投影：投影那一份一定是"可丢弃的副本"。
  // reflink 失败（卷不支持/命令缺失）时自动退到只读硬链接，绝不退成"各自真复制"。
  let effective = strategy;
  let installed = { reflink: 'reflinked', hardlink: 'hardlinked', symlink: 'linked', junction: 'linked', copy: 'copied' }[effective] || 'linked';
  atomicReplace(fs, projectionPath, (temporary) => {
    const stat = fs.lstatSync(storePath);
    if (effective === 'symlink' || effective === 'junction') {
      fs.symlinkSync(storePath, temporary, normalizePlatform(platform) === 'win32' ? 'junction' : 'dir');
      return;
    }
    if (effective === 'reflink') {
      try {
        cloneViaPlatform(storePath, temporary, platform, { ...deps, fs });
        return;
      } catch (_error) {
        // 退一级：只读硬链接（库里内容不可变，硬链接共享 inode 是安全的）。
        effective = typeof fs.linkSync === 'function' ? 'hardlink' : 'copy';
        installed = effective === 'hardlink' ? 'hardlinked' : 'copied';
        try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_cleanupError) { /* noop */ }
      }
    }
    if (stat.isDirectory()) {
      if (effective === 'hardlink') {
        // 直接建链接树：不复制、不依赖目录可写，ext4/Windows 上行为一致。
        linkTree(fs, storePath, temporary);
      } else {
        fs.cpSync(storePath, temporary, {
          recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true
        });
      }
      // 目录权限必须显式冻结：否则投影是 0755，应用可以原地写坏共享 inode。
      freezeTree(fs, temporary);
      return;
    }
    if (effective === 'hardlink') {
      fs.linkSync(storePath, temporary);
      return;
    }
    fs.copyFileSync(storePath, temporary);
  });
  recordShare(fs, ledgerPath, projectionPath, cli, version, key, readFingerprint(fs, manifestPath));
  return { action: installed, strategy: effective, storePath };
}

// 构件库的 Go 执行点：Node 只负责发现路径，文件系统动作与账本由 Go 完成。
let artifactServiceState = null;

function resolveArtifactServiceBinary() {
  const override = String(process.env.AIH_ARTIFACT_GO_BINARY || '').trim();
  if (override) return override;
  const platform = process.platform;
  const arch = process.arch;
  const binary = platform === 'win32' ? 'aih-go.exe' : 'aih-go';
  return nodePath.join(nodePath.resolve(__dirname, '..', '..'), 'bin', 'native', platform + '-' + arch, binary);
}

function artifactServiceAvailable(binary) {
  if (artifactServiceState !== null) return artifactServiceState;
  try {
    const output = require('node:child_process').execFileSync(binary, ['__artifacts-ensure', '--capabilities'], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore']
    });
    artifactServiceState = String(output).trim() === 'aih-artifactstore-v1';
  } catch (_error) {
    artifactServiceState = false;
  }
  return artifactServiceState;
}

function runArtifactService(binary, payload) {
  const output = require('node:child_process').execFileSync(binary, ['__artifacts-ensure'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const text = String(output).trim();
  if (!text) throw new Error('artifact_service_empty_output');
  return JSON.parse(text);
}

/**
 * 准备一个账号投影的共享构件。
 *
 * @param {Object} options
 * @param {string} options.provider
 * @param {string} options.projectionRoot  账号投影根（伪 HOME）
 * @param {string} options.hostHomeDir     真实宿主家目录
 * @param {string} options.storeRoot       构件库根（`<aiHome>/artifact-store`）
 * @param {string} [options.projectionsRoot] 所有账号投影的父目录（`<aiHome>/run/auth-projections`）；
 *        传了才会回收库内的过期版本树——拿不到就跳过，避免误删仍被引用的树。
 * @param {string} [options.trashDir]      回收站（默认 `<storeRoot>/trash`）
 * @param {boolean} [options.dryRun]
 * @returns {{caches: Object, versions: Array, pruned: Array, errors: Array}}
 */
function prepareProjectionArtifacts(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const provider = String(options.provider || '').trim().toLowerCase();
  const projectionRoot = String(options.projectionRoot || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = { caches: { linked: [], replaced: [], adopted: [], failed: [] }, versions: [], pruned: [], errors: [] };
  if (!projectionRoot || pathImpl.resolve(projectionRoot) === pathImpl.resolve(hostHomeDir)) return result;

  // 1) 环境变量覆盖不到的固定缓存路径。
  try {
    result.caches = linkSharedHostCaches({
      fs, path: pathImpl, platform, provider, projectionRoot, hostHomeDir
    });
  } catch (error) {
    result.errors.push({ step: 'shared_caches', error: String((error && error.message) || error) });
  }

  // 2) CLI 版本构件共享。
  const storeRoot = String(options.storeRoot || '').trim();
  result.backend = 'node';
  if (storeRoot && !options.dryRun) {
    const artifacts = listVersionArtifacts({ fs, projectionRoot });
    const mode = String(process.env.AIH_ARTIFACT_BACKEND || 'auto').toLowerCase();
    const binary = resolveArtifactServiceBinary();
    let sharedByService = false;
    if (artifacts.length > 0 && mode !== 'node' && artifactServiceAvailable(binary)) {
      try {
        const response = runArtifactService(binary, {
          provider,
          projectionRoot,
          storeRoot,
          projectionsRoot: String(options.projectionsRoot || '').trim(),
          platform,
          artifacts: artifacts.map((artifact) => ({ cli: artifact.cli, version: artifact.version, path: artifact.path }))
        });
        if (response && Array.isArray(response.versions)) {
          result.versions = response.versions;
          result.backend = 'go';
          sharedByService = true;
          for (const message of response.errors || []) {
            result.errors.push({ step: 'artifact_service', error: String(message) });
          }
        }
      } catch (error) {
        result.errors.push({ step: 'artifact_service', error: String((error && error.message) || error) });
      }
    }
    if (!sharedByService) {
      const seenRealPaths = new Set();
      let projectionRealRoot = '';
      try { projectionRealRoot = fs.realpathSync(projectionRoot); } catch (_error) { projectionRealRoot = ''; }
      for (const artifact of artifacts) {
        // `.local/share` 等目录可能整体链接到宿主 runtime home（旧的共享方式）：
        // 那份内容已经跨账号只有一份，不需要也不应该在每个账号里重铺/记账。
        let realPath = '';
        try { realPath = fs.realpathSync(artifact.path); } catch (_error) { realPath = artifact.path; }
        if (projectionRealRoot && realPath !== artifact.path
          && !realPath.startsWith(projectionRealRoot + nodePath.sep)) {
          result.versions.push({ cli: artifact.cli, version: artifact.version, action: 'shared-external', strategy: 'symlink-parent', storePath: '' });
          continue;
        }
        if (seenRealPaths.has(realPath)) continue;
        seenRealPaths.add(realPath);
        try {
          const outcome = shareVersionArtifact({
            fs, provider, cli: artifact.cli, version: artifact.version,
            projectionPath: artifact.path, storeRoot, platform, deps: options.deps
          });
          result.versions.push({ cli: artifact.cli, version: artifact.version, ...outcome });
        } catch (error) {
          result.errors.push({
            step: 'version_share',
            cli: artifact.cli,
            version: artifact.version,
            error: String((error && error.code) || (error && error.message) || error)
          });
        }
      }
    }
  }

  // 3) 回收：旧版本 + 过期日志/追踪 + 库内过期版本树。默认开启（保留策略见 DEFAULT_RETENTION）；
  // 在用的条目由 GC 自己按 argv/已打开文件跳过，凭据与会话库永远不在回收范围。
  // 删除一律先进回收站（同卷 rename），宽限期后再真正 unlink，留出反悔窗口。
  const retention = { ...DEFAULT_RETENTION, ...(options.retention || {}) };
  if (!options.dryRun && options.prune !== false && storeRoot && shouldRunGc(fs, storeRoot, retention.gcIntervalHours)) {
    try {
      const trashDir = String(options.trashDir || (storeRoot ? pathImpl.join(storeRoot, 'trash') : '')).trim();
      result.pruned.push(...pruneVersions({
        fs,
        projectionRoot,
        keepVersions: retention.keepVersions,
        trashDir,
        deps: options.deps
      }));
      result.pruned.push(...pruneLogs({
        fs,
        projectionRoot,
        maxAgeDays: retention.logMaxAgeDays,
        dirNames: retention.logDirNames,
        parents: retention.logParents,
        trashDir
      }));
      result.pruned.push(...pruneStoreTrees({
        fs,
        storeRoot,
        projectionsRoot: options.projectionsRoot,
        keepVersions: retention.keepVersions,
        platform,
        trashDir,
        deps: options.deps
      }));
      result.pruned.push(...emptyTrash({ fs, trashDir, graceDays: retention.trashGraceDays }));
      markGcRan(fs, storeRoot);
    } catch (error) {
      result.errors.push({ step: 'prune', error: String((error && error.message) || error) });
    }
  }

  return result;
}

module.exports = {
  DEFAULT_RETENTION,
  VERSION_ROOTS,
  compareVersions,
  listVersionArtifacts,
  prepareProjectionArtifacts,
  resetReflinkProbeCache,
  resolveShareStrategy,
  shareVersionArtifact,
  supportsReflink
};
