'use strict';

const nodePath = require('node:path');
const { normalizePathname } = require('./protocol-registry');

const MANIFEST_RELATIVE_PATH = ['contracts', 'route-ownership', 'manifest.json'];

// 只有数据面条目可以交给 Go；/healthz、/readyz 描述的是 Node 公开宿主自身，永远由 Node 应答。
const FORWARDABLE_ENTRY_PREFIX = 'gateway.';
const HOST_OWNED_ENTRY_IDS = new Set(['gateway.health', 'gateway.readiness']);

// 共享公开路径必须整条切流：同一路径的 HTTP 与 WebSocket 不能分属两个所有者。
const PAIRED_ENTRY_IDS = Object.freeze([
  ['gateway.openai.responses', 'gateway.openai.responses.websocket']
]);

function loadRouteOwnershipManifest(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const pathImpl = deps.path || nodePath;
  const repositoryRoot = deps.repositoryRoot || pathImpl.join(__dirname, '..', '..');
  const manifestPath = pathImpl.join(repositoryRoot, ...MANIFEST_RELATIVE_PATH);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 manifest 的路径模板编译成正则，并记录字面量长度用于最长匹配。 */
function compilePathPattern(pattern) {
  const source = String(pattern || '');
  let regex = '';
  let literalLength = 0;
  const tokenPattern = /\{beta\?\}|\{[^}]+\}|\/\*$/g;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const literal = source.slice(cursor, match.index);
    regex += escapeRegExp(literal);
    literalLength += literal.length;
    if (match[0] === '{beta?}') regex += '(?:beta)?';
    else if (match[0] === '/*') regex += '(?:/.*)?';
    else regex += '[^/]+';
    cursor = match.index + match[0].length;
  }
  const tail = source.slice(cursor);
  regex += escapeRegExp(tail);
  literalLength += tail.length;
  return { regex: new RegExp(`^${regex}$`), literalLength };
}

/**
 * 编译全部条目的 Node 公开路由。分类必须看全部条目而不只是被转发的条目，
 * 否则只划转 `/v1/models/{id}` 时会把 `/v1/models/x:generateContent` 也吞给 Go。
 */
function compileRouteTable(manifest) {
  const routes = [];
  for (const entry of (manifest && manifest.entries) || []) {
    for (const route of entry.node_routes || []) {
      const compiled = compilePathPattern(route.path);
      routes.push({
        entryId: entry.id,
        transport: route.transport === 'websocket' ? 'websocket' : 'http',
        methods: Array.isArray(route.methods) ? route.methods.map((m) => String(m).toUpperCase()) : null,
        ...compiled
      });
    }
  }
  return routes;
}

function classifyRoute(routeTable, request = {}) {
  const transport = request.transport === 'websocket' ? 'websocket' : 'http';
  const method = String(request.method || 'GET').toUpperCase();
  const pathname = normalizePathname(request.pathname);
  let best = null;
  for (const route of routeTable) {
    if (route.transport !== transport) continue;
    if (transport === 'http' && route.methods && !route.methods.includes(method)) continue;
    if (!route.regex.test(pathname)) continue;
    if (!best || route.literalLength > best.literalLength) best = route;
  }
  return best ? best.entryId : '';
}

function parseEntryIdList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

/**
 * 求出应由 Go 处理的条目集合：manifest 已正式 go_owned 的条目 ∪ 运维显式 canary。
 * canary 任一项非法则整体作废（不做部分生效），错误逐条返回给调用方报告。
 */
function resolveGoOwnedEntryIds(manifest, requestedIds = []) {
  const entries = new Map(((manifest && manifest.entries) || []).map((entry) => [entry.id, entry]));
  const owned = new Set();
  for (const entry of entries.values()) {
    if (entry.production_owner === 'go' && entry.migration_state === 'go_owned') owned.add(entry.id);
  }

  const requested = parseEntryIdList(requestedIds);
  const errors = [];
  for (const id of requested) {
    const entry = entries.get(id);
    if (!entry) errors.push(`unknown route entry: ${id}`);
    else if (!id.startsWith(FORWARDABLE_ENTRY_PREFIX) || HOST_OWNED_ENTRY_IDS.has(id)) {
      errors.push(`route entry is owned by the Node host: ${id}`);
    } else if (!Array.isArray(entry.go_routes) || entry.go_routes.length === 0) {
      errors.push(`route entry has no Go implementation: ${id}`);
    }
  }
  const combined = new Set([...owned, ...requested]);
  for (const pair of PAIRED_ENTRY_IDS) {
    const present = pair.filter((id) => combined.has(id));
    if (present.length > 0 && present.length < pair.length) {
      errors.push(`route entries must move together: ${pair.join(' + ')}`);
    }
  }

  if (errors.length > 0) return { entryIds: owned, canaryIds: [], errors };
  return { entryIds: combined, canaryIds: requested.filter((id) => !owned.has(id)), errors };
}

module.exports = {
  classifyRoute,
  compilePathPattern,
  compileRouteTable,
  loadRouteOwnershipManifest,
  parseEntryIdList,
  resolveGoOwnedEntryIds
};
