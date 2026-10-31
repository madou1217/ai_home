'use strict';

// 把构建产物 hash 写进 dist/sw.js 的 CACHE_NAME。
//
// 背景：sw.js 对 .js/.css/.png 走 Cache First，缓存名不变时浏览器会一直命中旧缓存
// （2026-10-14 实测：改前端后文件名 hash 没变 → 页面仍是旧文案，必须手工 bump 缓存名）。
// 构建时自动带上 hash，就不再依赖人记得这件事。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 构建先输出到暂存目录（AIH_WEB_OUT_DIR，见 build-locked.cjs），戳打在暂存目录里，替换后才生效。
const distDir = path.resolve(__dirname, '..', process.env.AIH_WEB_OUT_DIR || 'dist');
const swPath = path.join(distDir, 'sw.js');

function main() {
  // 用整个产物的文件清单算 hash：懒加载分片变了缓存名也要变（只盯主包会漏）。
  const files = fs.readdirSync(distDir, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry !== 'sw.js')
    .sort();
  if (!files.length) throw new Error('stamp-sw-cache: dist is empty');
  const digest = crypto.createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 8);
  const cacheName = `aih-hos6-pwa-${digest}`;
  const sw = fs.readFileSync(swPath, 'utf8');
  const next = sw.replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = '${cacheName}';`);
  if (next === sw && !sw.includes(`'${cacheName}'`)) {
    throw new Error('stamp-sw-cache: CACHE_NAME declaration not found in dist/sw.js');
  }
  fs.writeFileSync(swPath, next);
  process.stdout.write(`stamp-sw-cache: CACHE_NAME=${cacheName} (${files.length} files)\n`);
}

main();
