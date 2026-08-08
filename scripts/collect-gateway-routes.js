#!/usr/bin/env node
'use strict';

/**
 * 采集 Node 与 Go 网关对外暴露的 HTTP 路径，供 docs/architecture/go-node-parity-matrix.md
 * 复核。
 *
 * 为什么需要它：判断「Go 何时能取代 Node 9527」必须基于两侧路由的实际差集，
 * 而不是印象。路径清单会随开发漂移，手工维护的矩阵很快失真，所以采集要可重跑。
 *
 * 只做只读源码扫描：不启动服务、不发请求、不读凭据。
 *
 * 用法:
 *   node scripts/collect-gateway-routes.js          分组打印两侧清单与差集
 *   node scripts/collect-gateway-routes.js --json   输出机器可读 JSON，供 CI 比对
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const REPO_ROOT = nodePath.resolve(__dirname, '..');
const NODE_SERVER_DIR = nodePath.join(REPO_ROOT, 'lib', 'server');
const GO_ROUTER = nodePath.join(
  REPO_ROOT, 'internal', 'host', 'aihserver', 'router.go'
);
const GO_TRANSPORT_DIR = nodePath.join(REPO_ROOT, 'internal', 'transport', 'http');
const GO_CONTRACT_DIR = nodePath.join(REPO_ROOT, 'internal', 'contracts');

/** Node 侧对外路径的前缀白名单：只收网关真正暴露的命名空间。 */
const NODE_PATH_RE =
  /'(\/(?:v0|v1|v1beta|ui|healthz|readyz)[a-zA-Z0-9/_.:-]*)'/g;

function readFileSafe(file) {
  try {
    return nodeFs.readFileSync(file, 'utf8');
  } catch (_error) {
    return '';
  }
}

function collectNodePaths() {
  let entries;
  try {
    entries = nodeFs.readdirSync(NODE_SERVER_DIR);
  } catch (_error) {
    return [];
  }
  const files = [
    'server.js',
    'v1-router.js',
    'web-ui-router.js',
    ...entries.filter((name) => /^webui-.*-routes\.js$/.test(name))
  ].map((name) => nodePath.join(NODE_SERVER_DIR, name));

  const found = new Set();
  for (const file of files) {
    const text = readFileSafe(file);
    let match;
    NODE_PATH_RE.lastIndex = 0;
    while ((match = NODE_PATH_RE.exec(text))) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Go 侧路由挂在常量上（mux.Handle(pkg.Path, ...)），因此先收集所有
 * 传输层与契约包里的路径常量，再取 router.go 实际挂载的那些。
 */
function collectGoPaths() {
  const constants = new Map();
  const aliases = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.go') || entry.name.endsWith('_test.go')) continue;
      const text = readFileSafe(full);
      // 必须按「包名.常量名」建索引：Path 这类常量名在多个传输包里重复，
      // 只按常量名会互相覆盖，导致差集虚高。包名取所在目录名，与 router.go
      // 里的导入别名一致。
      const pkg = nodePath.basename(dir);
      const re = /([A-Za-z][A-Za-z0-9_]*)\s*=\s*"(\/[^"]*)"/g;
      let match;
      while ((match = re.exec(text))) constants.set(`${pkg}.${match[1]}`, match[2]);
      // 别名常量：Path = gatewaycontract.SelectionPath。值不是字面量，先记依赖，
      // 全部文件扫完后再解析，避免依赖遍历顺序。
      //
      // 目标包必须由本文件的 import 块精确解析：SelectionPath 这类常量名同样
      // 跨包重复，只按名字匹配会命中多个而被歧义保护丢弃。
      const importAlias = new Map();
      const importRe =
        /(?:^|\n)\s*([a-z][A-Za-z0-9_]*)?\s*"github\.com\/[^"]*\/([A-Za-z0-9_]+)"/g;
      while ((match = importRe.exec(text))) {
        const target = match[2];
        importAlias.set(match[1] || target, target);
      }
      const aliasRe =
        /([A-Za-z][A-Za-z0-9_]*)\s*=\s*([a-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*$/gm;
      while ((match = aliasRe.exec(text))) {
        const targetPkg = importAlias.get(match[2]) || match[2];
        aliases.push([`${pkg}.${match[1]}`, `${targetPkg}.${match[3]}`]);
      }
    }
  };
  walk(GO_TRANSPORT_DIR);
  walk(GO_CONTRACT_DIR);
  // 解析别名：目标已是「包名.常量名」全限定，直接查表，不做模糊匹配。
  for (const [aliasKey, targetKey] of aliases) {
    if (constants.has(aliasKey)) continue;
    const value = constants.get(targetKey);
    if (value) constants.set(aliasKey, value);
  }

  const routerText = readFileSafe(GO_ROUTER);
  const found = new Set();
  const literal = /mux\.HandleFunc\(\s*"([^"]+)"/g;
  let match;
  while ((match = literal.exec(routerText))) found.add(match[1]);
  const viaConstant =
    /mux\.Handle\(\s*(?:\n\s*)?([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)/g;
  while ((match = viaConstant.exec(routerText))) {
    const value = constants.get(`${match[1]}.${match[2]}`);
    if (value) found.add(value);
  }
  // clauderelayleaseapi.Path 转指 contracts 包的常量，需再解一层别名。
  for (const [key, value] of constants) {
    if (!key.endsWith('.Path')) continue;
    const pkg = key.slice(0, -'.Path'.length);
    if (routerText.includes(`${pkg}.Path`)) found.add(value);
  }
  return [...found].filter((p) => p !== '/').sort();
}

/** 按命名空间分组，便于按组而不是按条做归属决策。 */
function groupPaths(paths) {
  const groups = new Map();
  for (const p of paths) {
    let key;
    if (p.startsWith('/v0/webui/')) key = `/v0/webui/${p.split('/')[3] || ''}`;
    else if (p.startsWith('/v1/management/')) key = '/v1/management';
    else if (p.startsWith('/v1beta')) key = '/v1beta';
    else if (p.startsWith('/v1/')) key = '/v1';
    else key = p;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()]
    .map(([key, list]) => [key, list.sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function main() {
  const asJson = process.argv.slice(2).includes('--json');
  const nodePaths = collectNodePaths();
  const goPaths = collectGoPaths();
  const goSet = new Set(goPaths);
  // Go 只服务 /v1 数据面与 /healthz /readyz；/v0 是 WebUI 后端，不计入差集。
  const comparable = nodePaths.filter(
    (p) => p.startsWith('/v1') || p === '/healthz' || p === '/readyz'
  );
  const missingInGo = comparable.filter((p) => !goSet.has(p));

  if (asJson) {
    console.log(JSON.stringify({
      collectedAt: new Date().toISOString().slice(0, 10),
      node: { total: nodePaths.length, paths: nodePaths },
      go: { total: goPaths.length, paths: goPaths },
      comparable: { total: comparable.length, missingInGo }
    }, null, 2));
    return;
  }

  console.log(`Node 网关路径: ${nodePaths.length}`);
  for (const [key, list] of groupPaths(nodePaths)) {
    console.log(`\n### ${key}  (${list.length})`);
    for (const p of list) console.log(`  ${p}`);
  }
  console.log(`\n\nGo 网关路径: ${goPaths.length}`);
  for (const p of goPaths) console.log(`  ${p}`);
  console.log(`\n\n数据面差集（Node 有 / Go 无，仅比 /v1 与健康检查）: ${missingInGo.length}`);
  for (const p of missingInGo) console.log(`  ${p}`);
}

main();
