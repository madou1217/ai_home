'use strict';

// mmdb 格式的 geo provider（GeoLite2 / DB-IP / 任何标准 MaxMind 格式的库）。
//
// 为什么要一份通用实现：GeoLite2-Country / GeoLite2-ASN / GeoLite2-City / DB-IP City Lite
// **都是 mmdb 格式**，差别只在「库里有哪些字段」。所以读取代码一份，字段映射按库类型声明 ——
// 新增一个 mmdb 数据源 = 加一条声明，不改读取逻辑（与协议插件的扩展方式一致）。
//
// 读取用 maxmind 包（纯 JS）。查询是 mmdb 的二分查找，微秒级、零网络。
//
// 字段映射的差异（实测确认）：
//   - GeoLite2-Country: country.iso_code / country.names
//   - GeoLite2-ASN:     autonomous_system_number / autonomous_system_organization
//   - GeoLite2-City:    country + subdivisions[0] + city + location
//   - DB-IP City Lite:  与 City 同形（它的设计目标就是兼容 MaxMind 读取器）

const nodeFs = require('node:fs');
const { resolveGeoFile } = require('../paths');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从 mmdb 记录里取国家/省州/城市（各库字段名不同，这里统一）。 */
function mapMmdbRecord(record, kind) {
  if (!record || typeof record !== 'object') return null;
  const out = {};
  // 真实数据差异：有些网段只有 registered_country 没有 country（实测 1.1.1.1 就是这样），
  // 两个都看，优先 country。
  const country = record.country || record.registered_country || {};
  const iso = normalizeString(country.iso_code);
  if (iso) out.country = iso.toUpperCase();
  // 省州：GeoLite2-City / DB-IP 都在 subdivisions[0]。
  const subdivision = Array.isArray(record.subdivisions) && record.subdivisions[0] ? record.subdivisions[0] : null;
  if (subdivision) out.region = normalizeString(subdivision.names && subdivision.names.en) || normalizeString(subdivision.iso_code);
  const city = record.city && record.city.names ? record.city.names.en : '';
  if (city) out.city = normalizeString(city);
  // ASN 库的字段。
  const asnNumber = record.autonomous_system_number;
  if (Number.isInteger(asnNumber) && asnNumber > 0) out.asn = `AS${asnNumber}`;
  const asnOrg = normalizeString(record.autonomous_system_organization);
  if (asnOrg) out.org = asnOrg;
  if (kind === 'asn' && !out.asn) return null;
  return Object.keys(out).length ? out : null;
}

/**
 * 建一个 mmdb provider。
 * @param {object} options
 * @param {string} options.id         provider id（'geolite2-country' / 'dbip-city' …）
 * @param {string} options.name       展示名
 * @param {string} options.fileKind   paths.js 里的 kind（决定去哪找文件）
 * @param {object} options.capabilities 能力声明（country/region/city/asn）
 */
function createMmdbProvider(options = {}) {
  const id = normalizeString(options.id);
  const fileKind = normalizeString(options.fileKind);
  const fs = options.fs || nodeFs;
  const capabilities = { ...(options.capabilities || {}) };
  // 懒加载并缓存 reader（mmdb 打开后常驻内存映射，重复打开是浪费）。
  let reader = null;
  let readerPath = '';
  let lastError = '';

  function open() {
    const located = resolveGeoFile(fileKind, { fs, aiHomeDir: options.aiHomeDir, homeDir: options.homeDir });
    if (!located) {
      lastError = 'geo_file_missing';
      return null;
    }
    if (reader && readerPath === located.path) return reader;
    try {
      // 用 mmdb-lib 的同步 Reader：查询本身是同步的（mmdb 是二分查找），
      // maxmind@5 把它包成了异步 API，与这里的同步调用链不匹配。
      // eslint-disable-next-line global-require
      const { Reader } = require('mmdb-lib');
      reader = new Reader(fs.readFileSync(located.path));
      readerPath = located.path;
      lastError = '';
      return reader;
    } catch (error) {
      reader = null;
      readerPath = '';
      lastError = normalizeString(error && error.message) || 'geo_file_unreadable';
      return null;
    }
  }

  return {
    id,
    name: normalizeString(options.name) || id,
    capabilities,
    /** 数据文件在不在、能不能打开。 */
    available() {
      return open() !== null;
    },
    /** 当前用的文件路径（诊断用）。 */
    filePath() {
      return readerPath;
    },
    error() {
      return lastError;
    },
    /** IP → 归属地；查不到返回 null（不抛）。 */
    lookup(ip) {
      const instance = open();
      if (!instance) return null;
      let record = null;
      try {
        record = instance.get(normalizeString(ip));
      } catch (_error) {
        return null;
      }
      return mapMmdbRecord(record, fileKind);
    }
  };
}

module.exports = {
  createMmdbProvider,
  mapMmdbRecord
};
