'use strict';

// geo provider 注册表（Node 侧；Go 侧 internal/geo 同构）。
//
// **顺序即优先级**：链上从前到后尝试，前一个不可用/查不到自动切下一个。
// 排序原则：
//   1. 字段更全的在前（City 库能给城市，Country 库给不了）；
//   2. AIH 托管 / 本机客户端自带的差异由 paths.js 决定，注册表不关心文件在哪；
//   3. ASN 库排在最后：它只补 ASN 字段，不覆盖国家（chain 按字段合并，先到先得）。
//
// 新增数据源 = 这里加一行（+ 需要时在 paths.js 的 MANAGED_FILES 加文件名），
// 策略链、调用方、Go 侧对应实现都不动。

const { createMmdbProvider } = require('./mmdb');

/**
 * 建一组 provider（按优先级）。
 * @param {object} options { fs, aiHomeDir, homeDir }
 */
function createGeoProviders(options = {}) {
  const shared = { fs: options.fs, aiHomeDir: options.aiHomeDir, homeDir: options.homeDir };
  return [
    // 城市级优先（能同时给国家/省州/城市）：DB-IP City Lite（工具箱可下载）。
    createMmdbProvider({
      ...shared,
      id: 'dbip-city',
      name: 'DB-IP City Lite',
      fileKind: 'dbip-city',
      capabilities: { country: true, region: true, city: true, asn: false }
    }),
    // GeoLite2-City（用户自备则复用，本机默认没有）。
    createMmdbProvider({
      ...shared,
      id: 'geolite2-city',
      name: 'GeoLite2 City',
      fileKind: 'city',
      capabilities: { country: true, region: true, city: true, asn: false }
    }),
    // 国家库（本机 Surge / Clash Verge / MonoProxy 现成）。
    createMmdbProvider({
      ...shared,
      id: 'geolite2-country',
      name: 'GeoLite2 Country',
      fileKind: 'country',
      capabilities: { country: true, region: false, city: false, asn: false }
    }),
    // ASN 库（本机 Surge 现成）：只补 ASN / org，排在最后。
    createMmdbProvider({
      ...shared,
      id: 'geolite2-asn',
      name: 'GeoLite2 ASN',
      fileKind: 'asn',
      capabilities: { country: false, region: false, city: false, asn: true }
    })
  ];
}

/** 全部内置 provider 的声明（不实例化，供界面展示「支持哪些来源」）。 */
const GEO_PROVIDER_SPECS = Object.freeze([
  { id: 'dbip-city', name: 'DB-IP City Lite', capabilities: { country: true, region: true, city: true, asn: false }, download: 'auto' },
  { id: 'geolite2-city', name: 'GeoLite2 City', capabilities: { country: true, region: true, city: true, asn: false }, download: 'manual' },
  { id: 'geolite2-country', name: 'GeoLite2 Country', capabilities: { country: true, region: false, city: false, asn: false }, download: 'manual' },
  { id: 'geolite2-asn', name: 'GeoLite2 ASN', capabilities: { country: false, region: false, city: false, asn: true }, download: 'manual' }
]);

module.exports = {
  GEO_PROVIDER_SPECS,
  createGeoProviders
};
