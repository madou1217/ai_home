'use strict';

const FIELDS = Object.freeze(['upload', 'download', 'total', 'expire']);

/**
 * 机场面板通过 `subscription-userinfo` 响应头报告流量与到期时间：
 * `upload=1; download=2; total=3; expire=1700000000`（字节；expire 为秒级时间戳）。
 */
function parseSubscriptionUserInfo(header) {
  const text = Array.isArray(header) ? header[0] : header;
  if (!text || typeof text !== 'string') return null;
  const info = {};
  for (const part of text.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = String(rawKey || '').trim().toLowerCase();
    const value = Number(String(rawValue || '').trim());
    if (FIELDS.includes(key) && Number.isFinite(value) && value >= 0) info[key] = Math.floor(value);
  }
  return Object.keys(info).length ? info : null;
}

/** 多个订阅的用量合并：流量相加，到期取最早的有效时间。 */
function aggregateSubscriptionUserInfo(list = []) {
  const infos = list.filter((info) => info && typeof info === 'object');
  if (!infos.length) return null;
  const sum = (field) => infos.reduce((total, info) => total + (Number(info[field]) || 0), 0);
  const expires = infos.map((info) => Number(info.expire) || 0).filter((value) => value > 0);
  return {
    upload: sum('upload'),
    download: sum('download'),
    total: sum('total'),
    ...(expires.length ? { expire: Math.min(...expires) } : {})
  };
}

function formatSubscriptionUserInfo(info) {
  if (!info) return '';
  return FIELDS.filter((field) => info[field] !== undefined).map((field) => `${field}=${info[field]}`).join('; ');
}

module.exports = {
  aggregateSubscriptionUserInfo,
  formatSubscriptionUserInfo,
  parseSubscriptionUserInfo
};
