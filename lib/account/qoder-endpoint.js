'use strict';

// Qoder 推理端点的唯一解析处（推理 transport 与模型发现共用）。
//
// 取值顺序：
//   1. 账号投影 / 宿主客户端的端点缓存 `qoder-client-endpoint-cache.json`
//      （`entries.prod.endpointSets.inference.selected`，官方客户端网络选路的结果）；
//   2. 布局表里的默认端点（`lib/runtime/qoder-client-layouts.js`）。
//
// 这里不认 provider 名：端点与客户端目录都从布局表推导，新增站点只加布局。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { resolveQoderClientLayout } = require('../runtime/qoder-client-layouts');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJsonFile(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function qoderClientDir(provider, version) {
  const layout = resolveQoderClientLayout({ provider, version: version || '' });
  return layout && typeof layout.homeDir === 'string' ? layout.homeDir : '';
}

function qoderDefaultEndpoint(provider, version) {
  const layout = resolveQoderClientLayout({ provider, version: version || '' });
  return layout && layout.endpoints && typeof layout.endpoints.inference === 'string'
    ? layout.endpoints.inference
    : '';
}

function clientCacheCandidates({ fs, path, provider, runtimeDir, hostHomeDir, version }, fileName) {
  const clientDir = qoderClientDir(provider, version);
  const candidates = [];
  if (runtimeDir) candidates.push(path.join(runtimeDir, '.cache', fileName));
  if (hostHomeDir && clientDir) candidates.push(path.join(hostHomeDir, clientDir, '.cache', fileName));
  return candidates;
}

/**
 * 解析推理端点。
 * @returns {{endpoint:string, source:'endpoint_cache'|'fallback', cachePath:string}}
 */
function resolveQoderHttpEndpoint(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const provider = normalizeString(input.provider).toLowerCase();
  const defaultEndpoint = qoderDefaultEndpoint(provider, input.version);
  if (!defaultEndpoint) {
    const error = new Error('qoder_http_unsupported_provider');
    error.code = 'qoder_http_unsupported_provider';
    throw error;
  }
  for (const filePath of clientCacheCandidates({ ...input, fs, path, provider }, 'qoder-client-endpoint-cache.json')) {
    const cache = readJsonFile(fs, filePath);
    const selected = normalizeString(
      cache && cache.entries && cache.entries.prod
      && cache.entries.prod.endpointSets && cache.entries.prod.endpointSets.inference
      && cache.entries.prod.endpointSets.inference.selected
    );
    if (/^https:\/\//i.test(selected)) {
      return { endpoint: selected.replace(/\/+$/, ''), source: 'endpoint_cache', cachePath: filePath };
    }
  }
  return { endpoint: defaultEndpoint, source: 'fallback', cachePath: '' };
}

module.exports = {
  normalizeString,
  qoderClientDir,
  readJsonFile,
  resolveQoderHttpEndpoint
};
