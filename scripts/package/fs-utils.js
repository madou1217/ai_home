'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyTree(source, destination, options = {}) {
  const stat = fs.statSync(source);
  if (stat.isSymbolicLink() && options.dereference !== false) {
    // fs.cp 的 dereference 只对递归复制生效；单文件符号链接要自己解引用。
    const real = fs.realpathSync(source);
    return copyTree(real, destination, options);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (entry === '.DS_Store' || entry.startsWith('._')) continue;
      copyTree(path.join(source, entry), path.join(destination, entry), options);
    }
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stat.mode & 0o777);
  return destination;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Tree(root) {
  const hash = crypto.createHash('sha256');
  const entries = [];
  walk(root, '');
  entries.sort((left, right) => left.relative.localeCompare(right.relative));
  for (const entry of entries) {
    hash.update(`${entry.relative}\0${entry.size}\0`);
    hash.update(fs.readFileSync(entry.absolute));
  }
  return { sha256: hash.digest('hex'), fileCount: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };

  function walk(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === '.DS_Store' || name === '._.DS_Store') continue;
      const absolute = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const resolved = fs.statSync(absolute);
        if (resolved.isDirectory()) {
          walk(fs.realpathSync(absolute), childRelative);
        } else {
          entries.push({ relative: childRelative, absolute: fs.realpathSync(absolute), size: resolved.size });
        }
      } else if (stat.isDirectory()) {
        walk(absolute, childRelative);
      } else if (stat.isFile()) {
        entries.push({ relative: childRelative, absolute, size: stat.size });
      }
    }
  }
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkFiles(root, options = {}) {
  const results = [];
  const skip = new Set(options.skip || []);
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) results.push(absolute);
      else if (entry.isSymbolicLink() && fs.statSync(absolute).isFile()) results.push(absolute);
    }
  };
  visit(root);
  return results;
}

module.exports = {
  copyTree,
  ensureDir,
  readJson,
  removeIfExists,
  sha256File,
  sha256Tree,
  walkFiles,
  writeJson
};
