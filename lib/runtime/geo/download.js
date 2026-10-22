'use strict';

// GeoIP 数据文件的**下载与更新**（Node 侧；Go 侧同构）。
//
// 为什么需要（2026-10-22 用户要求）：城市级精度只有 City 库才有，而本机现成的
// Country/ASN 库给不了城市。DB-IP City Lite 免注册、mmdb 格式（与 GeoLite2 同一套读取器）、
// 每月更新 —— 适合自动拉取。下载做成工具箱里可管理的动作（用户能看进度、能手动更新）。
//
// 安全与稳健（下载是不可信输入）：
//   - 只从固定域名下载（download.db-ip.com），不接受调用方传任意 URL；
//   - 下载到临时文件、校验是 mmdb（尾部有 \xab\xcd\xefMaxMind.com 元数据标记）、
//     校验通过才**原子替换**目标文件（rename）—— 下载中断/数据损坏都不会破坏现有可用文件；
//   - gzip 解压有大小上限（防解压炸弹）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeZlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const { managedGeoDir, MANAGED_FILES } = require('./paths');

// 固定来源（不接受调用方传 URL）。当月不存在时回退到上月（DB-IP 每月 1 日发布）。
const DBIP_URL_TEMPLATE = 'https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz';
const DBIP_FALLBACK_MONTHS = 2;
// mmdb 元数据标记：文件尾部必有这一段，用它校验「下下来的确实是 mmdb」。
const MMDB_METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d]);
// 解压后大小上限（DB-IP City Lite 约 130MB，留一倍余量）。
const MAX_DECOMPRESSED_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 候选月份：当月 → 上月（DB-IP 月初发布，当月可能还没出）。 */
function candidateMonths(now = new Date(), count = DBIP_FALLBACK_MONTHS) {
  const months = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    months.push(monthKey(date));
  }
  return months;
}

/** 文件是不是 mmdb（尾部有元数据标记）。 */
function looksLikeMmdb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 128 * 1024));
  return tail.includes(MMDB_METADATA_MARKER);
}

/**
 * 下载并安装 DB-IP City Lite。
 * @param {object} options
 * @param {string} options.aiHomeDir
 * @param {Function} [options.fetchImpl] 注入用（测试）
 * @param {Function} [options.onProgress] ({ phase, receivedBytes, totalBytes, percent })
 * @returns {Promise<{ok:true, path:string, bytes:number, month:string} | {ok:false, error:string}>}
 */
async function downloadDbipCity(options = {}) {
  const fs = options.fs || nodeFs;
  const dir = managedGeoDir(options.aiHomeDir);
  if (!dir) return { ok: false, error: 'ai_home_dir_required' };
  const target = nodePath.join(dir, MANAGED_FILES['dbip-city']);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const months = candidateMonths(options.now || new Date());

  let lastError = '';
  for (const month of months) {
    const url = DBIP_URL_TEMPLATE.replace('{month}', month);
    try {
      onProgress({ phase: 'downloading', month, receivedBytes: 0, totalBytes: 0, percent: 0 });
      const response = await fetchImpl(url, {
        headers: { accept: 'application/octet-stream', 'user-agent': 'ai-home-geo/1.0' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if (!response || !response.ok) {
        lastError = `http_${response ? response.status : 0}`;
        continue;
      }
      const totalBytes = Number(response.headers.get('content-length')) || 0;
      // 边下边解压，避免把 60MB 压缩包与 130MB 解压结果同时留在内存。
      const gunzip = nodeZlib.createGunzip();
      let decompressed = 0;
      const chunks = [];
      gunzip.on('data', (chunk) => {
        decompressed += chunk.length;
        if (decompressed > MAX_DECOMPRESSED_BYTES) {
          gunzip.destroy(new Error('geo_download_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      // fetch 的 body 是 Web Stream，转成 Node Stream 再喂给 gunzip。
      const source = Readable.fromWeb(response.body);
      let received = 0;
      source.on('data', (chunk) => {
        received += chunk.length;
        onProgress({
          phase: 'downloading',
          month,
          receivedBytes: received,
          totalBytes,
          percent: totalBytes ? Math.round((received / totalBytes) * 100) : 0
        });
      });
      await pipeline(source, gunzip);
      const buffer = Buffer.concat(chunks);
      if (!looksLikeMmdb(buffer)) {
        lastError = 'geo_download_not_mmdb';
        continue;
      }
      // 原子替换：先写临时文件再 rename，失败不破坏现有文件。
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buffer, { mode: 0o600 });
      fs.renameSync(tmp, target);
      onProgress({ phase: 'done', month, receivedBytes: buffer.length, totalBytes: buffer.length, percent: 100 });
      return { ok: true, path: target, bytes: buffer.length, month };
    } catch (error) {
      lastError = String((error && (error.code || error.message)) || 'download_failed');
    }
  }
  return { ok: false, error: lastError || 'geo_download_failed' };
}

/** 托管目录里已有文件的现状（工具箱展示用）。 */
function describeManagedGeoFiles(options = {}) {
  const fs = options.fs || nodeFs;
  const dir = managedGeoDir(options.aiHomeDir);
  if (!dir) return [];
  return Object.entries(MANAGED_FILES).map(([kind, fileName]) => {
    const filePath = nodePath.join(dir, fileName);
    try {
      const stat = fs.statSync(filePath);
      return { kind, fileName, path: filePath, present: stat.isFile() && stat.size > 0, bytes: stat.size, updatedAt: Number(stat.mtimeMs) || 0 };
    } catch (_error) {
      return { kind, fileName, path: filePath, present: false, bytes: 0, updatedAt: 0 };
    }
  });
}

module.exports = {
  DBIP_URL_TEMPLATE,
  MAX_DECOMPRESSED_BYTES,
  candidateMonths,
  describeManagedGeoFiles,
  downloadDbipCity,
  looksLikeMmdb
};
