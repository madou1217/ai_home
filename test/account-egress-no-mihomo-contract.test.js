'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function productionSources(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (/\.(?:js|ts|tsx)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  visit(path.join(projectRoot, root));
  return files;
}

test('Toolkit 不再暴露账号代理池、代理核心、系统代理或 TUN 控制面', () => {
  const toolkit = read('web/src/pages/Toolkit.tsx');
  assert.doesNotMatch(toolkit, /ProxyPoolPanel|ProxyDiagnosticsPanel|proxy-pool|代理池与分流/u);
  assert.doesNotMatch(toolkit, /系统代理|AIH TUN|启动核心/u);

  assert.equal(
    fs.existsSync(path.join(projectRoot, 'web/src/components/toolkit/proxy-pool')),
    false,
    'Toolkit 代理池组件目录必须删除'
  );

  const toolkitRoutes = read('lib/server/webui-toolkit-routes.js');
  assert.doesNotMatch(toolkitRoutes, /webui-proxy-pool-routes|system-network-manager|\/proxy-pool/u);
});

test('账号出口目录取代 Toolkit proxy-pool API，并继续保留节点与订阅能力', () => {
  const api = read('web/src/services/api.ts');
  const accountModal = read('web/src/features/accounts/ZcodeEgressModal.tsx');
  assert.match(api, /export const accountEgressCatalogAPI/u);
  assert.match(api, /\/webui\/account-egress\/catalog\/(?:nodes|subscriptions)/u);
  assert.doesNotMatch(api, /proxyPoolAPI|\/webui\/toolkit\/proxy-pool/u);
  assert.match(accountModal, /accountEgressCatalogAPI/u);
  assert.match(accountModal, /AccountEgressImportModal/u);
  assert.equal(
    fs.existsSync(path.join(projectRoot, 'lib/account/account-egress-catalog-service.js')),
    true,
    '账号出口目录服务必须存在'
  );
  assert.equal(
    fs.existsSync(path.join(projectRoot, 'lib/server/webui-account-egress-catalog-routes.js')),
    true,
    '账号出口目录 HTTP 边界必须存在'
  );
});

test('生产源码不再包含 Mihomo 数据面或安装入口', () => {
  const forbiddenFiles = [
    'lib/cli/services/toolkit/proxy-pool/mihomo-config-compiler.js',
    'lib/cli/services/toolkit/proxy-pool/mihomo-core-manager.js',
    'lib/cli/services/toolkit/proxy-pool/mihomo-runtime.js',
    'lib/cli/services/toolkit/proxy-pool/proxy-pool-service.js',
    'lib/server/webui-proxy-pool-routes.js'
  ];
  for (const relativePath of forbiddenFiles) {
    assert.equal(fs.existsSync(path.join(projectRoot, relativePath)), false, `${relativePath} 必须删除`);
  }

  const offenders = productionSources('lib')
    .concat(productionSources('web/src'))
    .filter((filePath) => /\bmihomo\b|AIH_MIHOMO_BIN/iu.test(fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(projectRoot, filePath));
  assert.deepEqual(offenders, []);
});

test('Server 生命周期不再创建或关闭 Toolkit 代理核心', () => {
  const server = read('lib/server/server.js');
  assert.doesNotMatch(server, /closeDefaultProxyPoolService|proxy-pool-service/u);
});
