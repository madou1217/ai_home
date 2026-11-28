'use strict';

// web/dist 的新鲜度指纹：把“会影响产物”的输入做一次内容哈希，写进 dist 里的
// BUILD_STAMP.json。打包时指纹不匹配就必须重建，避免把旧 UI 静默打进发布包
//（旧行为只看 index.html 是否存在，web/src 改了也照样复用）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STAMP_NAME = 'BUILD_STAMP.json';
const STAMP_SCHEMA = 1;

// 参与指纹的目录与文件。node_modules、dist、output、.cache 是产物或依赖缓存，
// 参与哈希会自指；.umi 之类的临时目录由下面的 SKIP_DIRS 兜底。
const INPUT_ENTRIES = [
  'src',
  'config',
  'scripts',
  'public',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'eslint.config.js'
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'output', '.cache', '.umi', '.git']);

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function collect(directory, relative, entries) {
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '.DS_Store' || name.startsWith('._')) continue;
    const absolute = path.join(directory, name);
    const rel = relative ? relative + '/' + name : name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(absolute, rel, entries);
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push(rel + '\0' + stat.size + '\0' + hashFile(absolute));
  }
}

// computeWebFingerprint 返回内容指纹；同名文件、同大小但内容不同也会变。
function computeWebFingerprint(webRoot) {
  const entries = [];
  for (const name of INPUT_ENTRIES) {
    const absolute = path.join(webRoot, name);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) collect(absolute, name, entries);
    else if (stat.isFile()) entries.push(name + '\0' + stat.size + '\0' + hashFile(absolute));
  }
  const digest = crypto.createHash('sha256');
  digest.update('schema=' + STAMP_SCHEMA + '\n');
  digest.update('node=' + process.version + '\n');
  digest.update(entries.sort().join('\n'));
  return digest.digest('hex');
}

function readWebStamp(distDir) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(distDir, STAMP_NAME), 'utf8'));
    if (!stamp || stamp.schema !== STAMP_SCHEMA || typeof stamp.fingerprint !== 'string') return null;
    return stamp;
  } catch (_error) {
    return null;
  }
}

function writeWebStamp(distDir, fingerprint) {
  const stamp = {
    schema: STAMP_SCHEMA,
    fingerprint,
    node: process.version,
    built_at: new Date().toISOString()
  };
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, STAMP_NAME), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

module.exports = { STAMP_NAME, computeWebFingerprint, readWebStamp, writeWebStamp };
