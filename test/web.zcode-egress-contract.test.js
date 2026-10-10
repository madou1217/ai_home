'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const apiPath = path.join(projectRoot, 'web/src/services/api.ts');
const modalPath = path.join(projectRoot, 'web/src/features/accounts/ZcodeEgressModal.tsx');
const importModalPath = path.join(projectRoot, 'web/src/components/toolkit/proxy-pool/ProxyImportModal.tsx');
const groupManagerPath = path.join(projectRoot, 'web/src/features/accounts/ZcodeProxyGroupManagerModal.tsx');
const toolkitPanelPath = path.join(projectRoot, 'web/src/components/toolkit/AppManagerPanel.tsx');
const taskQueuePath = path.join(projectRoot, 'web/src/components/task-queue/AppInstallTaskQueue.tsx');
const accountRoutesPath = path.join(projectRoot, 'lib/server/webui-account-routes.js');
const toolkitRoutesPath = path.join(projectRoot, 'lib/server/webui-toolkit-routes.js');

test('所有 provider 账号菜单都用语义化出口图标打开独立弹窗', () => {
  assert.equal(fs.existsSync(modalPath), true, '出口设置必须拆到独立受控组件');
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');

  assert.match(accountsSource, /import \{ AccountEgressModal \} from '@\/features\/accounts\/ZcodeEgressModal'/);
  assert.match(accountsSource, /GlobalOutlined/);
  assert.match(accountsSource, /key: 'account-egress'/);
  assert.match(accountsSource, /setAccountEgressAccount\(record\)/);
  assert.match(accountsSource, /<AccountEgressModal/);
  assert.doesNotMatch(accountsSource, /record\.provider\s*===\s*['"]zcode['"][\s\S]{0,160}account-egress/);
});

test('账号出口弹窗只提供外部代理地址、系统代理、外部 TUN 三种来源', () => {
  assert.equal(fs.existsSync(modalPath), true, '出口设置弹窗尚未实现');
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /accountsAPI\.getAccountEgress\(account\.provider, account\.accountRef\)/);
  assert.match(modalSource, /accountsAPI\.saveAccountEgress\(account\.provider, account\.accountRef/);
  assert.match(modalSource, /proxyUrl:\s*values\.mode === 'url' \? String\(values\.proxyUrl/);
  for (const mode of ['system', 'tun', 'url']) {
    assert.match(modalSource, new RegExp(`value=["']${mode}["']`), mode);
  }
  assert.doesNotMatch(modalSource, /value=["'](node|group|pool)["']/, '节点 / 分组 / 代理池出口已下线');
  assert.match(modalSource, /不运行代理内核、不开本地端口/);
  assert.match(modalSource, /不支持 SOCKS/);
  assert.match(modalSource, /setting\.json/);
  assert.match(modalSource, /模型.*MCP.*命令工具.*内置浏览器.*setting\.json/s);
  assert.match(modalSource, /中性连通性地址/);
  assert.match(modalSource, /不调用 ZCode 接口/);
  assert.match(modalSource, /不会改写系统代理/);
  assert.match(modalSource, /不会创建或接管 TUN/);
  assert.match(modalSource, /出口不可用时阻止启动与请求并保留现有设置/);
  assert.match(modalSource, /绑定记录无法读取或 marker 无法识别时同样阻止启动/);
  assert.match(modalSource, /用户手工设置不变/);
  assert.match(modalSource, /以新出口重启该实例/);
  assert.match(modalSource, /response\.apply/);
  // 已下线绑定：提示改绑，不把它当成可选模式。
  assert.match(modalSource, /isRetiredEgressBinding\(binding\)/);
  assert.match(modalSource, /已随 AIH 本地代理端口一起下线/);
  assert.doesNotMatch(modalSource, /sing-box|sidecar|proxyPoolAPI|rotateAccountEgress|ProxyImportModal|ZcodeProxyGroupManagerModal/);
  assert.doesNotMatch(modalSource, /释放 AIH 上次托管值|回到直连|fail-open/i);
  assert.doesNotMatch(modalSource, /Anthropic/i);
  assert.doesNotMatch(modalSource, /Mihomo/i);
  assert.doesNotMatch(modalSource, /\bAlert\b|borderLeft|border-left/);
});

test('账号出口不再依赖节点库：导入弹窗、分组管理与代理池前端 API 均已删除', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');

  assert.equal(fs.existsSync(importModalPath), false);
  assert.equal(fs.existsSync(groupManagerPath), false);
  assert.doesNotMatch(apiSource, /proxyPoolAPI|\/webui\/toolkit\/proxy-pool\//);
});

test('ZCode 出口弹窗捕获表单校验拒绝，不留下未处理 Promise', () => {
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /try\s*\{\s*values\s*=\s*await form\.validateFields\(\)/s);
});

test('账号出口 API 使用 provider 与账号双重作用域并编码路径参数', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');

  assert.match(apiSource, /getAccountEgress:\s*async\s*\(provider: string, accountRef: string\)/);
  assert.match(apiSource, /saveAccountEgress:\s*async\s*\(/);
  assert.match(apiSource, /encodeURIComponent\(provider\).*encodeURIComponent\(accountRef\).*\/egress/s);
  assert.doesNotMatch(apiSource, /rotateAccountEgress|\/egress\/rotate/);
  assert.doesNotMatch(apiSource, /listGroups:|upsertGroup:|updateGroupPolicy:|deleteGroup:/);
});

test('账号出口类型只含三种模式，并能表达已下线绑定与解析后的运行态', () => {
  const typesSource = fs.readFileSync(path.join(projectRoot, 'web/src/types/index.ts'), 'utf8');

  assert.match(typesSource, /AccountEgressMode\s*=\s*'system'\s*\|\s*'tun'\s*\|\s*'url';/);
  assert.match(typesSource, /RetiredAccountEgressMode\s*=\s*'node'\s*\|\s*'group'\s*\|\s*'pool'/);
  assert.match(typesSource, /retired\?:\s*boolean/);
  assert.match(typesSource, /apply\?:\s*AccountEgressApplyResult/);
  assert.match(typesSource, /runtime\?:\s*AccountEgressRuntimeStatus/);
  assert.match(typesSource, /resolved:\s*AccountEgressResolvedTarget \| null/);
  assert.match(typesSource, /status\?:\s*'applied'\s*\|\s*'cleared'\s*\|\s*'restarted'/);
  assert.doesNotMatch(typesSource, /canRotate|AccountEgressHealthStatus|AccountEgressRotateResponse/);
});

test('账号打开 ZCode Desktop 时展示出口未生效警告', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');

  assert.match(accountsSource, /result\.egressWarning/);
  assert.match(accountsSource, /message\.warning\([^)]*egressWarning/);
});

test('Toolkit 的两个 Desktop 启动入口都展示已运行实例的出口重载警告', () => {
  for (const filePath of [toolkitPanelPath, taskQueuePath]) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.match(source, /response\.egressWarning/, filePath);
    assert.match(source, /message\.warning\([^)]*egressWarning/, filePath);
  }
});

test('ZCode Desktop 启动入口不再向出口 service 传递 Mihomo ProxyPoolService', () => {
  const accountRoutesSource = fs.readFileSync(accountRoutesPath, 'utf8');
  const toolkitRoutesSource = fs.readFileSync(toolkitRoutesPath, 'utf8');

  assert.doesNotMatch(
    accountRoutesSource,
    /proxyPoolService:\s*ctx\.proxyPoolService\s*\|\|\s*routeDeps\.proxyPoolService/
  );
  assert.doesNotMatch(
    toolkitRoutesSource,
    /proxyPoolService:\s*toolkitOptions\.proxyPoolService/
  );

  const { pickZcodeEgressDependencies } = require('../lib/server/zcode-egress-service');
  const selected = pickZcodeEgressDependencies({
    proxyPoolService: { engine: 'mihomo' },
    probeProxyServer: () => ({ ok: true })
  });
  assert.equal(selected.proxyPoolService, undefined);
  assert.equal(typeof selected.probeProxyServer, 'function');
});
