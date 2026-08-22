#!/usr/bin/env node
'use strict';

/**
 * 采集 Node 与 Go 网关的路由合同，供 ownership manifest、parity 文档和测试复核。
 *
 * 这不是运行时路由表，也不启动任何服务。它只读取源码，保留命中表达式及其行号，
 * 并明确区分：
 *   - endpoint：实际交给处理器的路径/路径模式；
 *   - guard：命名空间或鉴权/作用域判断，不能当成端点；
 *   - fallback：未命中处理器时的兜底；
 *   - http / websocket：同一路径的不同传输合同。
 *
 * 用法:
 *   node scripts/collect-gateway-routes.js          人类可读摘要
 *   node scripts/collect-gateway-routes.js --json   机器可读路由基线
 *
 * 重要：这是源码证据扫描器，不伪装成 AST 或运行时探针。动态拼接、运行时注册的
 * 路由会以 explicit/manual evidence 的形式补入，无法静默变成“已覆盖”。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const REPO_ROOT = nodePath.resolve(__dirname, '..');

const NODE_HTTP_FILES = [
  'lib/server/v1-router.js',
  'lib/server/web-ui-router.js',
  'lib/server/management-router.js',
  'lib/server/node-rpc-router.js',
  'lib/server/fabric-router.js',
  'lib/server/server.js',
  ...listFiles('lib/server', (name) => /^webui-.*-routes\.js$/.test(name)),
];

const GO_ROUTER_FILE = 'internal/host/aihserver/router.go';
const GO_SCAN_DIRS = [
  'internal/host/aihserver',
  'internal/transport/http',
  'internal/contracts',
];

const PUBLIC_PATH_PREFIXES = [
  '/v0',
  '/v1',
  '/v1beta',
  '/ui',
  '/healthz',
  '/readyz',
];

const METHOD_ORDER = [
  'OPTIONS',
  'HEAD',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  '*',
];

const GO_METHODS_BY_MOUNT = Object.freeze({
  '/healthz': ['GET', 'HEAD'],
  '/readyz': ['GET', 'HEAD'],
  '/v1/models': ['GET', 'HEAD'],
  '/v1/props': ['GET'],
  '/v1/responses': ['POST'],
  '/v1/chat/completions': ['POST'],
  '/v1/messages': ['POST'],
  '/v1/claude-relay-leases': ['POST'],
  '/v1/management/accounts': ['GET', 'POST'],
  '/v1/management/accounts/': ['GET', 'PATCH', 'PUT', 'DELETE', 'POST'],
  '/v1/management/account-aliases/': ['GET'],
  '/v1/management/account-imports': ['POST'],
  '/v1/management/account-imports/sub2api': ['POST'],
  '/v1/management/account-defaults/': ['GET', 'PUT', 'DELETE'],
  '/v1/management/account-selections/resolve': ['POST'],
  '/v1/management/account-auth-jobs': ['POST'],
  '/v1/management/account-auth-jobs/': ['GET', 'DELETE', 'POST'],
});

function listFiles(relativeDir, predicate) {
  const dir = nodePath.join(REPO_ROOT, relativeDir);
  let entries;
  try {
    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && (!predicate || predicate(entry.name)))
    .map((entry) => nodePath.join(relativeDir, entry.name))
    .sort();
}

function readFileSafe(file) {
  try {
    return nodeFs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
}

function relativeSourcePath(file) {
  return nodePath.relative(REPO_ROOT, file).split(nodePath.sep).join('/');
}

function lineNumber(text, index) {
  return String(text).slice(0, Math.max(0, index)).split('\n').length;
}

function sourceEvidence(file, text, index, expression) {
  const line = lineNumber(text, index);
  const lines = text.split('\n');
  return {
    file: relativeSourcePath(file),
    line,
    expression: String(expression || '').trim(),
    raw_line: String(lines[line - 1] || '').trim(),
  };
}

function normalizeMethods(methods) {
  const unique = new Set(
    (Array.isArray(methods) ? methods : [methods])
      .map((method) => String(method || '').trim().toUpperCase())
      .filter(Boolean),
  );
  if (unique.size === 0) unique.add('*');
  return [...unique].sort((left, right) => {
    const leftIndex = METHOD_ORDER.indexOf(left);
    const rightIndex = METHOD_ORDER.indexOf(right);
    return (leftIndex < 0 ? METHOD_ORDER.length : leftIndex)
      - (rightIndex < 0 ? METHOD_ORDER.length : rightIndex);
  });
}

function methodFromContext(text, index) {
  const start = Math.max(0, index - 280);
  const end = Math.min(text.length, index + 80);
  const context = text.slice(start, end);
  const methods = [];
  const methodRe = /(?:\b(?:ctx\.)?method|\b(?:req|request)\.method)\s*===\s*['"]([A-Za-z]+)['"]/g;
  let match;
  while ((match = methodRe.exec(context))) methods.push(match[1]);
  return normalizeMethods(methods);
}

function resolveTemplate(value, constants, seen = new Set()) {
  let result = String(value || '');
  const constantRe = /\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g;
  result = result.replace(constantRe, (_full, name) => {
    if (seen.has(name) || !Object.prototype.hasOwnProperty.call(constants, name)) return '${' + name + '}';
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveTemplate(constants[name], constants, nextSeen);
  });
  return result;
}

function collectStringConstants(text) {
  const constants = {};
  const constantRe = /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(['"`])([\s\S]*?)\2/g;
  let match;
  while ((match = constantRe.exec(text))) {
    const resolved = resolveTemplate(match[3], constants);
    if (resolved.startsWith('/')) constants[match[1]] = resolved;
  }
  return constants;
}

function decodeLiteral(value) {
  try {
    return JSON.parse('"' + String(value).replace(/"/g, '\\"') + '"');
  } catch (_error) {
    return String(value || '');
  }
}

function normalizePrefixPath(path) {
  const value = String(path || '').trim().replace(/\/$/, '');
  if (value === '/v1/blobs') return '/v1/blobs/{id}';
  if (value === '/v0/webui/accounts/add/jobs') return '/v0/webui/accounts/add/jobs/{job_id}';
  return value || '/';
}

function regexToPath(pattern) {
  let value = String(pattern || '').trim();
  value = value.replace(/^\^/, '').replace(/\$$/, '');
  value = value.replace(/\\\//g, '/');
  value = value.replace(/\(\?:beta\)\?/g, '{beta?}');
  value = value.replace(/\(\?:\(([^)]+)\)\)\?/g, '{$1?}');
  value = value.replace(/\(\[\^\/\]\+\)/g, '{param}');
  value = value.replace(/\[\^\/\]\+/g, '{param}');
  value = value.replace(/\[\^\/\]\*/g, '{param?}');
  value = value.replace(/\(\[A-Za-z0-9_-\]\+\)/g, '{id}');
  value = value.replace(/\(\[A-Za-z0-9_\-\]\+\)/g, '{id}');
  value = value.replace(/\(\[0-9\]\+\)/g, '{id}');
  value = value.replace(/\(\.\+\)/g, '{rest}');
  value = value.replace(/\(\?:[^)]+\)/g, '{param}');
  value = value.replace(/\([^)]*\)/g, '{param}');
  value = value.replace(/\\([.*+?()[\]{}|])/g, '$1');
  return value || '/';
}

function isPublicPath(path) {
  const value = String(path || '').trim();
  return PUBLIC_PATH_PREFIXES.some((prefix) => (
    value === prefix
    || value.startsWith(prefix + '/')
    || value.startsWith(prefix + '{')
    || value.startsWith(prefix + '[')
    || value.startsWith(prefix + '(')
  ));
}

function isScopeGuard(file, text, index, matchType, path) {
  if (matchType !== 'prefix') return false;
  const before = text.slice(Math.max(0, index - 180), index + 40);
  if (/!\s*(?:pathname|ctx\.pathname)\.startsWith/.test(before)) return true;
  if (file.endsWith('/v1-router.js') && (path === '/v1/' || path === '/v1beta/')) return true;
  if (file.endsWith('/server.js') && path === '/v0/webui') return true;
  if (file.endsWith('/web-ui-router.js') && path === '/v0/webui') return true;
  return false;
}

function routeKind(file, text, index, matchType, path) {
  if (isScopeGuard(file, text, index, matchType, path)) return 'guard';
  if (matchType === 'fallback') return 'fallback';
  return 'endpoint';
}

function createRoute({
  file,
  text,
  index,
  path,
  pattern,
  match,
  methods,
  transport = 'http',
  kind,
  expression,
  evidenceKind = 'source',
  protocolId = '',
}) {
  const normalizedMethods = normalizeMethods(methods);
  const route = {
    path: String(path || '/'),
    pattern: String(pattern || path || '/'),
    match: String(match || 'exact'),
    methods: normalizedMethods,
    method: normalizedMethods.length === 1 ? normalizedMethods[0] : '*',
    transport,
    kind: kind || routeKind(file, text, index, match, path),
    route_kind: kind || routeKind(file, text, index, match, path),
    evidence_kind: evidenceKind,
    source: sourceEvidence(file, text, index, expression),
  };
  if (protocolId) route.protocol_id = protocolId;
  return route;
}

function addRoute(routes, route) {
  if (!route || !isPublicPath(route.path) && route.path !== '/') return;
  const key = [
    route.transport,
    route.kind,
    route.match,
    route.path,
    route.methods.join(','),
  ].join('|');
  const existing = routes.find((item) => item._key === key);
  if (existing) {
    existing.sources = existing.sources || [existing.source];
    if (route.source && !existing.sources.some((item) => item.file === route.source.file && item.line === route.source.line)) {
      existing.sources.push(route.source);
    }
    if (route.protocol_id && !existing.protocol_ids.includes(route.protocol_id)) {
      existing.protocol_ids.push(route.protocol_id);
    }
    return;
  }
  const next = {
    ...route,
    _key: key,
    protocol_ids: route.protocol_id ? [route.protocol_id] : [],
  };
  routes.push(next);
}

function finalizeRoutes(routes) {
  return routes
    .map((route) => {
      const next = { ...route };
      delete next._key;
      if (next.sources && next.sources.length > 1) {
        next.source_count = next.sources.length;
      }
      if (next.protocol_ids.length === 0) delete next.protocol_ids;
      delete next.protocol_id;
      return next;
    })
    .sort((left, right) => {
      const leftKey = `${left.transport}|${left.kind}|${left.path}|${left.method}`;
      const rightKey = `${right.transport}|${right.kind}|${right.path}|${right.method}`;
      return leftKey.localeCompare(rightKey);
    });
}

function scanRegexLiteral(text, startIndex) {
  let slash = text.indexOf('/', startIndex);
  if (slash < 0) return null;
  let escaped = false;
  let inClass = false;
  for (let index = slash + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === ']') {
      inClass = false;
      continue;
    }
    if (char === '/' && !inClass) {
      let end = index + 1;
      while (/[a-z]/i.test(text[end] || '')) end += 1;
      return {
        raw: text.slice(slash, end),
        pattern: text.slice(slash + 1, index),
        end,
      };
    }
  }
  return null;
}

function scanNodeFile(file, routes) {
  const absolute = nodePath.join(REPO_ROOT, file);
  const text = readFileSafe(absolute);
  if (!text) return;
  const upgradeStart = file.endsWith('/server.js')
    ? text.indexOf("server.on('upgrade'")
    : -1;
  const constants = collectStringConstants(text);

  const addLiteral = (index, fullExpression, rawPath, match, pathOverride) => {
    // server.js 的 upgrade 分支拥有独立的 WebSocket 合同；HTTP 路由由
    // protocol-registry/v1-router 提供，避免把 isResponsesPath 误报成 HTTP endpoint。
    if (upgradeStart >= 0 && index >= upgradeStart) return;
    if (
      file.endsWith('/server.js')
      && (rawPath === '/healthz' || rawPath === '/readyz')
    ) return;
    if (file.endsWith('/web-ui-router.js') && rawPath === '/ui') return;
    const kind = routeKind(file, text, index, match, rawPath);
    const path = pathOverride || (
      match === 'prefix' && kind !== 'guard' ? normalizePrefixPath(rawPath) : rawPath
    );
    if (!isPublicPath(path) && path !== '/') return;
    const methods = methodFromContext(text, index);
    addRoute(routes, createRoute({
      file: absolute,
      text,
      index,
      path,
      pattern: match === 'prefix' ? `${rawPath}*` : rawPath,
      match,
      methods,
      kind,
      expression: fullExpression,
    }));
  };

  const exactLiteralRe = /(?:\bpathname|\bctx\.pathname|\burl\.pathname)\s*===\s*(['"])(\/[^'"\n]+)\1/g;
  let match;
  while ((match = exactLiteralRe.exec(text))) {
    addLiteral(match.index, match[0], match[2], 'exact');
  }

  const prefixLiteralRe = /(?:\bpathname|\bctx\.pathname|\burl\.pathname)\s*\.startsWith\(\s*(['"])(\/[^'"\n]+)\1\s*\)/g;
  while ((match = prefixLiteralRe.exec(text))) {
    addLiteral(match.index, match[0], match[2], 'prefix');
  }

  const exactConstantRe = /(?:\bpathname|\bctx\.pathname|\burl\.pathname)\s*===\s*([A-Z][A-Za-z0-9_]*)/g;
  while ((match = exactConstantRe.exec(text))) {
    const value = constants[match[1]];
    if (value) addLiteral(match.index, match[0], value, 'exact');
  }

  const prefixConstantRe = /(?:\bpathname|\bctx\.pathname|\burl\.pathname)\s*\.startsWith\(\s*([A-Z][A-Za-z0-9_]*)\s*\)/g;
  while ((match = prefixConstantRe.exec(text))) {
    const value = constants[match[1]];
    if (value) addLiteral(match.index, match[0], value, 'prefix');
  }

  const matchCallRe = /(?:\bpathname|\bctx\.pathname)\.match\(\s*/g;
  while ((match = matchCallRe.exec(text))) {
    const regex = scanRegexLiteral(text, match.index + match[0].length);
    if (!regex) continue;
    const path = regexToPath(regex.pattern);
    if (!isPublicPath(path)) continue;
    addRoute(routes, createRoute({
      file: absolute,
      text,
      index: match.index,
      path,
      pattern: regex.pattern,
      match: 'regex',
      methods: methodFromContext(text, match.index),
      kind: routeKind(file, text, match.index, 'regex', path),
      expression: text.slice(match.index, regex.end + 1),
    }));
  }
}

function collectNodeProtocolRoutes(routes) {
  const file = nodePath.join(REPO_ROOT, 'lib/server/protocol-registry.js');
  const text = readFileSafe(file);
  if (!text) return;
  const protocolRe = /\{\s*id:\s*['"]([^'"]+)['"][\s\S]*?method:\s*['"]([A-Z]+)['"][\s\S]*?match:\s*\(pathname\)\s*=>\s*([^\n]+?)(?=\n\s*\})/g;
  let match;
  while ((match = protocolRe.exec(text))) {
    const protocolId = match[1];
    const method = match[2];
    const predicate = match[3].trim();
    let path = '';
    let matchType = 'exact';
    let pattern = predicate;
    const exact = predicate.match(/pathname\s*===\s*['"]([^'"]+)['"]/);
    if (exact) {
      path = exact[1];
    } else if (predicate.includes('generateContent') || predicate.includes('streamGenerateContent')) {
      path = predicate.includes('streamGenerateContent')
        ? '/v1{beta?}/models/{model}:streamGenerateContent'
        : '/v1{beta?}/models/{model}:generateContent';
      pattern = predicate;
      matchType = 'regex';
    }
    if (!path) continue;
    const index = match.index + match[0].indexOf('match:');
    addRoute(routes, createRoute({
      file,
      text,
      index,
      path,
      pattern,
      match: matchType,
      methods: [method],
      kind: 'endpoint',
      expression: match[0],
      evidenceKind: 'protocol_registry',
      protocolId,
    }));
  }
}

function addKnownNodeRoutes(routes) {
  const known = [
    {
      path: '/healthz',
      methods: ['GET'],
      file: 'lib/server/server.js',
      lineNeedle: "if (pathname === '/healthz')",
    },
    {
      path: '/readyz',
      methods: ['GET'],
      file: 'lib/server/server.js',
      lineNeedle: "if (pathname === '/readyz')",
    },
    {
      path: '/ui',
      methods: ['GET'],
      file: 'lib/server/web-ui-router.js',
      lineNeedle: "if (pathname === '/ui')",
    },
    {
      path: '/v1/models/{id}',
      pattern: '^/v1/models/([^/]+)$',
      match: 'regex',
      methods: ['GET'],
      file: 'lib/server/v1-router.js',
      lineNeedle: "match(/^\\/v1\\/models\\/([^/]+)$/)",
    },
    {
      path: '/v0/webui/accounts/codex/{account_ref}/reset-credits',
      pattern: '^/v0/webui/accounts/codex/([^/]+)/reset-credits$',
      match: 'regex',
      methods: ['GET'],
      file: 'lib/server/webui-codex-reset-credit-routes.js',
      lineNeedle: 'const LIST_PATTERN =',
    },
    {
      path: '/v0/webui/accounts/codex/{account_ref}/reset-credits/consume',
      pattern: '^/v0/webui/accounts/codex/([^/]+)/reset-credits/consume$',
      match: 'regex',
      methods: ['POST'],
      file: 'lib/server/webui-codex-reset-credit-routes.js',
      lineNeedle: 'const CONSUME_PATTERN =',
    },
    {
      path: '/v0/webui/accounts/codex/{account_ref}/reset-operations/{operation_id}',
      pattern: '^/v0/webui/accounts/codex/([^/]+)/reset-operations/([^/]+)$',
      match: 'regex',
      methods: ['GET'],
      file: 'lib/server/webui-codex-reset-credit-routes.js',
      lineNeedle: 'const OPERATION_PATTERN =',
    },
    {
      path: '/v0/webui/accounts/codex/{account_ref}/reset-operations/{operation_id}/reconcile',
      pattern: '^/v0/webui/accounts/codex/([^/]+)/reset-operations/([^/]+)/reconcile$',
      match: 'regex',
      methods: ['POST'],
      file: 'lib/server/webui-codex-reset-credit-routes.js',
      lineNeedle: 'const RECONCILE_PATTERN =',
    },
  ];
  for (const item of known) {
    const file = nodePath.join(REPO_ROOT, item.file);
    const text = readFileSafe(file);
    const index = text.indexOf(item.lineNeedle);
    if (index < 0) continue;
    addRoute(routes, createRoute({
      file,
      text,
      index,
      path: item.path,
      pattern: item.pattern || item.path,
      match: item.match || 'exact',
      methods: item.methods,
      kind: 'endpoint',
      expression: item.lineNeedle,
      evidenceKind: 'explicit_source',
    }));
  }
}

function addKnownNodeWebSocketRoutes(routes) {
  const known = [
    ['/v0/relay/node', 'lib/server/remote/relay-server.js', 'const RELAY_NODE_PATH ='],
    ['/v0/fabric/broker/control', 'lib/server/fabric-broker-router.js', 'const FABRIC_BROKER_CONTROL_PATH ='],
    ['/v0/fabric/transport/echo', 'lib/server/fabric-transport-echo-router.js', 'const FABRIC_TRANSPORT_ECHO_PATH ='],
    ['/v0/webui/accounts/watch', 'lib/server/server.js', "if (pathname === '/v0/webui/accounts/watch')"],
    ['/v1/responses', 'lib/server/server.js', 'const isResponsesPath = pathname ==='],
    ['/v0/codex/app-server', 'lib/server/codex-app-server-proxy.js', "normalized === '/v0/codex/app-server'"],
    ['/', 'lib/server/codex-app-server-proxy.js', "normalized === '/'"],
  ];
  for (const [path, relativeFile, needle] of known) {
    const file = nodePath.join(REPO_ROOT, relativeFile);
    const text = readFileSafe(file);
    const index = text.indexOf(needle);
    if (index < 0) continue;
    addRoute(routes, createRoute({
      file,
      text,
      index,
      path,
      pattern: path,
      match: 'exact',
      methods: ['GET'],
      transport: 'websocket',
      kind: 'endpoint',
      expression: needle,
      evidenceKind: 'explicit_source',
    }));
  }
}

function collectNodeRoutes() {
  const routes = [];
  for (const file of [...new Set(NODE_HTTP_FILES)]) scanNodeFile(file, routes);
  collectNodeProtocolRoutes(routes);
  addKnownNodeRoutes(routes);
  addKnownNodeWebSocketRoutes(routes);
  return finalizeRoutes(routes);
}

function parseGoStringConstants(file, constants) {
  const text = readFileSafe(file);
  const pkg = nodePath.basename(nodePath.dirname(file));
  const literalRe = /\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*"(\/[^"\n]*)"/g;
  let match;
  while ((match = literalRe.exec(text))) constants.set(`${pkg}.${match[1]}`, match[2]);
}

function parseGoImports(text) {
  const aliases = new Map();
  const importRe = /(?:^|\n)\s*([a-z][A-Za-z0-9_]*)?\s*"github\.com\/[^"\n]*\/([A-Za-z0-9_]+)"/g;
  let match;
  while ((match = importRe.exec(text))) aliases.set(match[1] || match[2], match[2]);
  return aliases;
}

function collectGoConstants() {
  const constants = new Map();
  const aliases = [];
  for (const relativeDir of GO_SCAN_DIRS) {
    const absoluteDir = nodePath.join(REPO_ROOT, relativeDir);
    const files = walkGoFiles(absoluteDir);
    for (const file of files) {
      const text = readFileSafe(file);
      parseGoStringConstants(file, constants);
      const pkg = nodePath.basename(nodePath.dirname(file));
      const importAliases = parseGoImports(text);
      const aliasRe = /\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*([a-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*$/gm;
      let match;
      while ((match = aliasRe.exec(text))) {
        aliases.push([`${pkg}.${match[1]}`, `${importAliases.get(match[2]) || match[2]}.${match[3]}`]);
      }
    }
  }
  for (const [alias, target] of aliases) {
    if (!constants.has(alias) && constants.has(target)) constants.set(alias, constants.get(target));
  }
  return constants;
}

function walkGoFiles(dir) {
  let entries;
  try {
    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkGoFiles(full));
    else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) files.push(full);
  }
  return files.sort();
}

function goRouteMethods(path, transport = 'http') {
  if (transport === 'websocket') return ['GET'];
  return GO_METHODS_BY_MOUNT[path] || ['*'];
}

function addGoRoute(routes, { file, text, index, path, pattern, match = 'exact', transport = 'http', kind = 'endpoint', expression }) {
  const methods = goRouteMethods(path, transport);
  const route = createRoute({
    file,
    text,
    index,
    path,
    pattern: pattern || path,
    match,
    methods,
    transport,
    kind,
    expression,
    evidenceKind: 'go_mux_mount',
  });
  addRoute(routes, route);
}

function collectGoRoutes() {
  const routes = [];
  const constants = collectGoConstants();
  const file = nodePath.join(REPO_ROOT, GO_ROUTER_FILE);
  const text = readFileSafe(file);

  const literalRe = /mux\.HandleFunc\(\s*"([^"\n]+)"/g;
  let match;
  while ((match = literalRe.exec(text))) {
    const path = match[1];
    if (path === '/') continue;
    addGoRoute(routes, {
      file,
      text,
      index: match.index,
      path,
      pattern: path,
      expression: match[0],
      kind: 'endpoint',
    });
  }

  const mountRe = /mux\.Handle\(\s*([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(\s*\+\s*"\/"|)/g;
  while ((match = mountRe.exec(text))) {
    const base = constants.get(`${match[1]}.${match[2]}`);
    if (!base) continue;
    const suffix = match[3] ? '/' : '';
    const path = `${base}${suffix}`;
    addGoRoute(routes, {
      file,
      text,
      index: match.index,
      path,
      pattern: suffix ? `${base}/*` : base,
      match: suffix ? 'prefix' : 'exact',
      expression: match[0],
      kind: 'endpoint',
    });
  }

  const fallbackIndex = text.indexOf('mux.HandleFunc("/",');
  if (fallbackIndex >= 0) {
    addRoute(routes, createRoute({
      file,
      text,
      index: fallbackIndex,
      path: '/',
      pattern: '/',
      match: 'exact',
      methods: ['*'],
      kind: 'fallback',
      expression: 'mux.HandleFunc("/", handleRouteNotFound)',
      evidenceKind: 'go_mux_mount',
    }));
  }

  const websocketSource = nodePath.join(
    REPO_ROOT,
    'internal/transport/http/codexresponsesws/handler.go',
  );
  const websocketText = readFileSafe(websocketSource);
  const websocketIndex = websocketText.indexOf('func IsUpgradeRequest');
  if (websocketIndex >= 0) {
    addRoute(routes, createRoute({
      file: websocketSource,
      text: websocketText,
      index: websocketIndex,
      path: '/v1/responses',
      pattern: '/v1/responses',
      match: 'exact',
      methods: ['GET'],
      transport: 'websocket',
      kind: 'endpoint',
      expression: 'IsUpgradeRequest(request) for /v1/responses',
      evidenceKind: 'go_websocket_dispatch',
    }));
  }

  return finalizeRoutes(routes);
}

function routeIdentity(route) {
  return `${route.transport}:${route.match}:${route.path}`;
}

function comparableNodeRoutes(routes) {
  return routes.filter((route) => (
    route.kind === 'endpoint'
    && route.transport === 'http'
    && (route.path.startsWith('/v1') || route.path === '/healthz' || route.path === '/readyz')
  ));
}

function buildComparison(nodeRoutes, goRoutes) {
  const nodeComparable = comparableNodeRoutes(nodeRoutes);
  const goKeys = new Set(goRoutes.filter((route) => route.kind === 'endpoint').map(routeIdentity));
  const missingInGo = nodeComparable
    .filter((route) => !goKeys.has(routeIdentity(route)))
    .map((route) => ({
      path: route.path,
      pattern: route.pattern,
      match: route.match,
      methods: route.methods,
      transport: route.transport,
      kind: route.kind,
    }));
  const guardRoutes = nodeRoutes.filter((route) => route.kind === 'guard');
  return {
    node_endpoint_count: nodeComparable.length,
    go_endpoint_count: goRoutes.filter((route) => route.kind === 'endpoint' && route.transport === 'http').length,
    missing_in_go: missingInGo,
    guard_count: guardRoutes.length,
    guards: guardRoutes.map((route) => ({
      path: route.path,
      pattern: route.pattern,
      methods: route.methods,
      transport: route.transport,
      kind: route.kind,
      source: route.source,
    })),
  };
}

function collectGatewayRoutes() {
  const nodeRoutes = collectNodeRoutes();
  const goRoutes = collectGoRoutes();
  return {
    schema_version: 2,
    collected_at: new Date().toISOString().slice(0, 10),
    source: {
      node_files: [...new Set(NODE_HTTP_FILES)].map((file) => file.replace(/\\/g, '/')).sort(),
      go_router: GO_ROUTER_FILE,
      go_scan_dirs: GO_SCAN_DIRS,
      mode: 'read_only_source_scan',
    },
    node: {
      total: nodeRoutes.length,
      endpoint_count: nodeRoutes.filter((route) => route.kind === 'endpoint').length,
      guard_count: nodeRoutes.filter((route) => route.kind === 'guard').length,
      fallback_count: nodeRoutes.filter((route) => route.kind === 'fallback').length,
      http_count: nodeRoutes.filter((route) => route.transport === 'http').length,
      websocket_count: nodeRoutes.filter((route) => route.transport === 'websocket').length,
      routes: nodeRoutes,
      paths: [...new Set(nodeRoutes.filter((route) => route.kind === 'endpoint').map((route) => route.path))].sort(),
    },
    go: {
      total: goRoutes.length,
      endpoint_count: goRoutes.filter((route) => route.kind === 'endpoint').length,
      guard_count: goRoutes.filter((route) => route.kind === 'guard').length,
      fallback_count: goRoutes.filter((route) => route.kind === 'fallback').length,
      http_count: goRoutes.filter((route) => route.transport === 'http').length,
      websocket_count: goRoutes.filter((route) => route.transport === 'websocket').length,
      routes: goRoutes,
      paths: [...new Set(goRoutes.filter((route) => route.kind === 'endpoint').map((route) => route.path))].sort(),
    },
    comparable: buildComparison(nodeRoutes, goRoutes),
  };
}

function groupRoutes(routes) {
  const groups = new Map();
  for (const route of routes) {
    const namespace = route.path.startsWith('/v0/webui/')
      ? '/v0/webui'
      : route.path.startsWith('/v0/')
        ? '/v0'
        : route.path.startsWith('/v1beta')
          ? '/v1beta'
          : route.path.startsWith('/v1/')
            ? '/v1'
            : route.path;
    if (!groups.has(namespace)) groups.set(namespace, []);
    groups.get(namespace).push(route);
  }
  return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function printRoutes(title, payload) {
  console.log(`\n${title}: ${payload.total} 条记录（endpoint=${payload.endpoint_count}, guard=${payload.guard_count}, fallback=${payload.fallback_count}, ws=${payload.websocket_count}）`);
  for (const [group, routes] of groupRoutes(payload.routes)) {
    console.log(`\n### ${group} (${routes.length})`);
    for (const route of routes) {
      console.log(`  ${route.transport.toUpperCase()} ${route.methods.join('|')} ${route.path} [${route.kind}/${route.match}]`);
    }
  }
}

function main() {
  const payload = collectGatewayRoutes();
  if (process.argv.slice(2).includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printRoutes('Node 网关路由', payload.node);
  printRoutes('Go 网关路由', payload.go);
  console.log(`\n数据面候选：Node endpoint=${payload.comparable.node_endpoint_count}，Go endpoint=${payload.comparable.go_endpoint_count}`);
  console.log(`Go 缺失 ${payload.comparable.missing_in_go.length} 条候选：`);
  for (const route of payload.comparable.missing_in_go) {
    console.log(`  ${route.methods.join('|')} ${route.path} [${route.match}]`);
  }
}

if (require.main === module) main();

module.exports = {
  GO_METHODS_BY_MOUNT,
  NODE_HTTP_FILES,
  REPO_ROOT,
  buildComparison,
  collectGatewayRoutes,
  collectGoRoutes,
  collectNodeRoutes,
  comparableNodeRoutes,
  normalizeMethods,
  regexToPath,
  routeIdentity,
};
