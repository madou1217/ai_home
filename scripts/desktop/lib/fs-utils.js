'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function writeJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  ensureParent(absolutePath);
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, absolutePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function listRecursively(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  if (!fs.existsSync(absoluteRoot)) {
    return [];
  }

  const entries = [];
  const visit = (currentPath) => {
    const stat = fs.lstatSync(currentPath);
    entries.push({ path: currentPath, stat });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }
    const children = fs.readdirSync(currentPath).sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      visit(path.join(currentPath, child));
    }
  };

  visit(absoluteRoot);
  return entries;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Tree(directoryPath) {
  const absoluteRoot = path.resolve(directoryPath);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const entries = listRecursively(absoluteRoot).slice(1);

  for (const entry of entries) {
    const relativePath = normalizePath(path.relative(absoluteRoot, entry.path));
    if (entry.stat.isSymbolicLink()) {
      hash.update(`link\0${relativePath}\0${entry.stat.mode & 0o777}\0${fs.readlinkSync(entry.path)}\n`);
      continue;
    }
    if (entry.stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0${entry.stat.mode & 0o777}\n`);
      continue;
    }
    if (!entry.stat.isFile()) {
      hash.update(`other\0${relativePath}\0${entry.stat.mode}\n`);
      continue;
    }

    const fileDigest = sha256File(entry.path);
    sizeBytes += entry.stat.size;
    hash.update(`file\0${relativePath}\0${entry.stat.mode & 0o777}\0${entry.stat.size}\0${fileDigest}\n`);
  }

  return {
    sha256: hash.digest('hex'),
    sizeBytes,
  };
}

function describeDigest(targetPath) {
  const stat = fs.lstatSync(targetPath);
  if (stat.isDirectory()) {
    return {
      digestMode: 'deterministic-tree-v1',
      ...sha256Tree(targetPath),
    };
  }
  if (!stat.isFile()) {
    throw new Error(`不支持计算摘要的文件类型: ${targetPath}`);
  }
  return {
    digestMode: 'file',
    sha256: sha256File(targetPath),
    sizeBytes: stat.size,
  };
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath, basePath = process.cwd()) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(path.resolve(basePath), absolutePath);
  if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..') {
    return normalizePath(relativePath);
  }
  return normalizePath(absolutePath);
}

function findFiles(rootPath, predicate) {
  return listRecursively(rootPath)
    .filter((entry) => predicate(entry.path, entry.stat))
    .map((entry) => entry.path);
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForFile(filePath, options = {}) {
  const timeoutMs = options.timeoutMs || 60_000;
  const intervalMs = options.intervalMs || 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待文件超时: ${displayPath(filePath)}`);
}

module.exports = {
  describeDigest,
  displayPath,
  ensureParent,
  findFiles,
  listRecursively,
  normalizePath,
  readJson,
  sha256File,
  sleep,
  waitForFile,
  writeJson,
};
