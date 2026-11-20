'use strict';

/**
 * 版本构件的事实层（version artifact facts）。
 *
 * 只做一件事：**声明**每个 CLI 的版本构件放在投影的哪个位置，并把它们列出来/排序。
 * 不含共享、不含删除——那两件事分别是 `projection-artifacts.js`（建共享）与
 * `artifact-gc.js`（做回收）的职责。
 *
 * 为什么要单独一层：共享与回收都必须对"哪些东西算版本构件"用同一套判定。放在任一方都会让
 * 另一方反向依赖它，形成循环。这里是两方共同的下层。
 *
 * 新增一个 harness/provider agent 的版本共享 = 在此表加一行，共享与回收同时生效。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** 版本号目录/文件名（`2.180.0`、`157.0.8103.78` 这类）；不匹配的一律不碰。 */
const VERSION_ENTRY_PATTERN = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 参与版本共享/回收的 CLI 数据根（相对账号投影）。
 *
 * 判定依据是「这个路径的内容在同一版本下跨账号逐字节相同」，因此可以只留一份。
 * 不含凭据、不含会话库、不含用户配置。
 */
const VERSION_ROOTS = Object.freeze([
  Object.freeze({
    cli: 'codebuddy',
    root: Object.freeze(['.local', 'share', 'codebuddy', 'versions'])
  }),
  Object.freeze({
    cli: 'claude',
    root: Object.freeze(['.local', 'share', 'claude', 'versions'])
  }),
  Object.freeze({
    cli: 'codebuddy-cn',
    root: Object.freeze(['.codebuddy-cn', 'versions'])
  }),
  // WorkBuddy 桌面自带的运行时（Node / Python）：每次下载一整份，跨账号逐字节相同。
  Object.freeze({
    cli: 'workbuddy-node',
    root: Object.freeze(['.workbuddy-ai', 'binaries', 'node', 'versions'])
  }),
  Object.freeze({
    cli: 'workbuddy-python',
    root: Object.freeze(['.workbuddy-ai', 'binaries', 'python', 'versions'])
  }),
  // agent-browser 下载的浏览器测试包（目录名带 `chrome-` 前缀，版本号在名字后半段）。
  Object.freeze({
    cli: 'agent-browser-chrome',
    root: Object.freeze(['.agent-browser', 'browsers']),
    prefix: 'chrome-'
  }),
  // Codex 桌面解压出来的运行时（generation-<id>，自带 node 与 node_modules）。
  // 应用自己写成只读 + 只新增 generation，因此可以按 generation 共享整个运行时。
  Object.freeze({
    cli: 'codex-artifact-runtime',
    root: Object.freeze(['electron-user-data', 'artifact-sessions', 'runtime-generations']),
    namePattern: /^generation-[A-Za-z0-9]+$/
  })
]);

function versionSortKey(name) {
  return String(name || '').split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

/** 语义化版本比较（段数不同也能比出大小）。 */
function compareVersions(left, right) {
  const a = versionSortKey(left);
  const b = versionSortKey(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 列出投影里所有 (cli, 版本) 构件。 */
function listVersionArtifacts(options = {}) {
  const fs = options.fs || nodeFs;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const roots = Array.isArray(options.versionRoots) ? options.versionRoots : VERSION_ROOTS;
  const found = [];
  if (!projectionRoot) return found;
  for (const declaration of roots) {
    const versionsDir = nodePath.join(projectionRoot, ...declaration.root);
    let names = [];
    try { names = fs.readdirSync(versionsDir); } catch (_error) { continue; }
    const prefix = String(declaration.prefix || '');
    const namePattern = declaration.namePattern instanceof RegExp ? declaration.namePattern : null;
    for (const name of names) {
      if (prefix && !name.startsWith(prefix)) continue;
      if (namePattern && !namePattern.test(name)) continue;
      const version = prefix ? name.slice(prefix.length) : name;
      if (!namePattern && !VERSION_ENTRY_PATTERN.test(version)) continue;
      found.push({ cli: declaration.cli, version, path: nodePath.join(versionsDir, name) });
    }
  }
  return found;
}

/**
 * 递归解除只读（删除/改名前的必备步骤）。
 *
 * 只读树是共享安全的基础（原地写会 EACCES，强逼安装器 unlink+rename），但 macOS 在
 * **改名目录** 时也要求目录自身可写，否则 rename 直接 EACCES；不先解冻就会出现
 * "删除静默失败、旧版本永远清不掉"。解冻保留可执行位，避免把 CLI 本体变成不可执行。
 */
function makeWritable(fs, root) {
  let info = null;
  try { info = fs.lstatSync(root); } catch (_error) { return; }
  if (info.isSymbolicLink()) return;
  try {
    if (info.isDirectory()) {
      fs.chmodSync(root, 0o755);
      let entries = [];
      try { entries = fs.readdirSync(root); } catch (_error) { entries = []; }
      for (const name of entries) makeWritable(fs, nodePath.join(root, name));
    } else {
      fs.chmodSync(root, (Number(info.mode) & 0o111) !== 0 ? 0o755 : 0o644);
    }
  } catch (_error) { /* 单项失败继续，交给调用方决定是否删除 */ }
}

/**
 * 只把**目录**改成可写（文件权限不动）。
 *
 * 删除/改名只需要父目录可写：unlink 一个 0444 文件不需要文件自身可写。保持文件权限不变，
 * 硬链接到同一 inode 的其它账号投影就不会因为"回收旧版本"而突然变成可写。
 */
function makeTreeRemovable(fs, root) {
  let info = null;
  try { info = fs.lstatSync(root); } catch (_error) { return; }
  if (info.isSymbolicLink()) return;
  let entries = [];
  try {
    if (info.isDirectory()) {
      try { fs.chmodSync(root, 0o755); } catch (_error) { /* 交给删除结果判定 */ }
      try { entries = fs.readdirSync(root); } catch (_error) { entries = []; }
      for (const name of entries) makeTreeRemovable(fs, nodePath.join(root, name));
    }
  } catch (_error) { /* 单项失败继续 */ }
}

/**
 * 确保**我们自己管理的目录**对当前用户可写（只给 owner 加 w，不改其它位）。
 *
 * 现实中出现过 `artifact-store/trees` 被误设为 0555 的情况：之后所有版本共享都
 * EACCES、旧版本也移不走，而且因为失败是静默的，表现成"共享莫名其妙不生效"。
 */
function ensureDirectoryWritable(fs, directory) {
  try { fs.mkdirSync(directory, { recursive: true }); } catch (_error) { return; }
  try {
    const info = fs.lstatSync(directory);
    if (info.isDirectory() && (Number(info.mode) & 0o200) === 0) fs.chmodSync(directory, Number(info.mode) | 0o200);
  } catch (_error) { /* 交给后续操作报错 */ }
}

module.exports = {
  VERSION_ENTRY_PATTERN,
  VERSION_ROOTS,
  compareVersions,
  ensureDirectoryWritable,
  listVersionArtifacts,
  makeTreeRemovable,
  makeWritable,
  versionSortKey
};
