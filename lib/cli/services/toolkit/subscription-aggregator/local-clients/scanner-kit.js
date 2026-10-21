'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('yaml');

// 扫描本地客户端配置的公共工具。插件只声明「在哪些目录找、文件长什么样、订阅地址在哪」，
// 读盘、上限、去重、与已导入源比对都在这里做。

const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_CLIENT = 40;

function readText(filePath, limit = MAX_PROFILE_BYTES, fsImpl) {
  fsImpl = fsImpl || fs;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > limit) return null;
    return fsImpl.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return null;
  }
}

/** filter 可以是函数或正则（插件里多数只按扩展名筛）。fsImpl / pathImpl 传 undefined 时用默认值。 */
function listFiles(dir, filter, options = {}) {
  const limit = options.limit || MAX_FILES_PER_CLIENT;
  const fsImpl = options.fsImpl || fs;
  const pathImpl = options.pathImpl || path;
  const accepts = filter instanceof RegExp ? (name) => filter.test(name) : filter;
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !accepts(entry.name)) continue;
    const filePath = pathImpl.join(dir, entry.name);
    let stat;
    try {
      stat = fsImpl.statSync(filePath);
    } catch (_error) {
      continue;
    }
    files.push({ path: filePath, name: entry.name, mtimeMs: Number(stat.mtimeMs || 0), size: Number(stat.size || 0) });
  }
  // 最近改过的在前：绝大多数时候要导入的就是当前在用的那份。
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

function parseYaml(text) {
  try {
    return yaml.parse(text);
  } catch (_error) {
    return null;
  }
}

// 订阅地址里的 name 参数是**展示名**（机场用它给订阅起名），不是凭据：
// 同一订阅换个名字仍是同一份，比较地址时排除它。
const DISPLAY_ONLY_PARAMS = new Set(['name']);

/**
 * 订阅地址的比较键：查询串是凭据，顺序不同仍是同一份订阅；末尾斜杠、默认端口、大小写都不算差异。
 * 只当展示用的参数（name）不参与比较。导入时仍用原地址。
 */
function subscriptionUrlKey(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !DISPLAY_ONLY_PARAMS.has(String(key).toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || String(leftValue).localeCompare(String(rightValue))
    ));
  url.search = '';
  url.hash = '';
  const base = `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  return params.length ? `${base}?${new URLSearchParams(params).toString()}` : base;
}

function displayNameFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const named = String(url.searchParams.get('name') || '').trim();
    return named || url.hostname.replace(/^www\./, '') || '订阅';
  } catch (_error) {
    return '订阅';
  }
}

/** 只接受 http(s) 订阅地址；导入用原样地址，保留凭据参数。 */
function normalizeSubscriptionUrl(value) {
  const key = subscriptionUrlKey(value);
  return key ? String(value).trim() : '';
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

/** Clash / mihomo 配置里的 proxy-providers → 订阅地址。 */
function clashProviderUrls(text) {
  const doc = parseYaml(text);
  const providers = doc && typeof doc === 'object' ? doc['proxy-providers'] : null;
  if (!providers || typeof providers !== 'object') return [];
  return Object.values(providers)
    .map((provider) => normalizeSubscriptionUrl(provider && typeof provider === 'object' ? provider.url : ''))
    .filter(Boolean);
}

/** Surge 配置：`#!MANAGED-CONFIG <url>` 与 `#!include <url>`（两者都可能是订阅地址）。 */
function surgeManagedUrls(text) {
  const urls = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*#!(?:MANAGED-CONFIG|include)\s+(\S+)/i);
    if (!match) continue;
    const url = normalizeSubscriptionUrl(match[1]);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * 把「一个文件 = 一个可导入配置」的客户端统一成同一个扫描器：
 * 读文件 → 插件抽地址 → 没有地址也能按内容导入（本地订阅）。
 */
function scanFiles({ dir, files, extractUrls, nameFor, fsImpl, pathImpl }) {
  return files.map((file) => {
    const content = readText(file.path, MAX_PROFILE_BYTES, fsImpl);
    if (content === null) return null;
    const urls = extractUrls(content) || [];
    const name = nameFor ? nameFor(file, content) : pathImpl.basename(file.name, pathImpl.extname(file.name));
    return {
      id: pathImpl.basename(file.path),
      name,
      url: urls[0] || '',
      filePath: file.path,
      updatedAt: file.mtimeMs || null,
      userInfo: null,
      contentHash: contentHash(content)
    };
  }).filter(Boolean);
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 扫描到的一个候选订阅（插件共用）。地址规范化失败（非 http(s)、带凭据）返回 null：
 * 这类地址不能当订阅导入。
 */
function createCandidate(client, input = {}) {
  const url = normalizeSubscriptionUrl(input.url);
  if (!url) return null;
  const name = String(input.name || '').trim() || displayNameFromUrl(url);
  return {
    id: `${client.id}:${url}`,
    clientId: client.id,
    clientName: client.name,
    name: name.slice(0, 64),
    url,
    file: String(input.file || ''),
    ...(input.updatedAt ? { updatedAt: Number(input.updatedAt) } : {})
  };
}

/** Clash / mihomo 配置里的 proxy-providers（保留名字）：机场订阅在本地的常见落点。 */
function proxyProviderEntries(document) {
  const providers = document && typeof document === 'object' ? document['proxy-providers'] : null;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Object.entries(providers)
    .map(([key, value]) => {
      if (!value || typeof value !== 'object' || !value.url) return null;
      return { name: String(value.name || key || ''), url: value.url };
    })
    .filter(Boolean);
}

module.exports = {
  MAX_FILES_PER_CLIENT,
  MAX_PROFILE_BYTES,
  clashProviderUrls,
  contentHash,
  createCandidate,
  displayNameFromUrl,
  listFiles,
  normalizeSubscriptionUrl,
  parseJson,
  parseYaml,
  proxyProviderEntries,
  readText,
  scanFiles,
  subscriptionUrlKey,
  surgeManagedUrls
};
