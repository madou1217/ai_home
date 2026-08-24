'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const apiPath = path.join(projectRoot, 'web/src/services/api.ts');
const modalPath = path.join(projectRoot, 'web/src/features/accounts/ZcodeEgressModal.tsx');
const groupManagerPath = path.join(projectRoot, 'web/src/features/accounts/ZcodeProxyGroupManagerModal.tsx');
const toolkitPanelPath = path.join(projectRoot, 'web/src/components/toolkit/AppManagerPanel.tsx');
const taskQueuePath = path.join(projectRoot, 'web/src/components/task-queue/AppInstallTaskQueue.tsx');
const accountRoutesPath = path.join(projectRoot, 'lib/server/webui-account-routes.js');
const toolkitRoutesPath = path.join(projectRoot, 'lib/server/webui-toolkit-routes.js');

test('ZCode 账号菜单用语义化出口图标打开独立弹窗', () => {
  assert.equal(fs.existsSync(modalPath), true, '出口设置必须拆到独立受控组件');
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');

  assert.match(accountsSource, /import \{ ZcodeEgressModal \} from '@\/features\/accounts\/ZcodeEgressModal'/);
  assert.match(accountsSource, /GlobalOutlined/);
  assert.match(accountsSource, /key: 'zcode-egress'/);
  assert.match(accountsSource, /setZcodeEgressAccount\(record\)/);
  assert.match(accountsSource, /<ZcodeEgressModal/);
});

test('ZCode 出口弹窗支持五种来源并复用节点库管理面', () => {
  assert.equal(fs.existsSync(modalPath), true, '出口设置弹窗尚未实现');
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /accountsAPI\.getZcodeEgress\(account\.accountRef\)/);
  assert.match(modalSource, /accountsAPI\.saveZcodeEgress\(account\.accountRef/);
  assert.match(modalSource, /proxyPoolAPI\.listNodes\(\)/);
  assert.match(modalSource, /proxyUrl:\s*String\(values\.proxyUrl/);
  assert.match(modalSource, /nodeId:\s*String\(values\.nodeId/);
  assert.match(modalSource, /groupId:\s*String\(values\.groupId/);
  for (const mode of ['system', 'tun', 'url', 'node', 'group']) {
    assert.match(modalSource, new RegExp(`value=["']${mode}["']`), mode);
  }
  assert.match(modalSource, /setting\.json/);
  assert.match(modalSource, /ZCode 原生/);
  assert.match(modalSource, /sing-box/);
  assert.match(modalSource, /127\.0\.0\.1/);
  assert.match(modalSource, /中性连通性地址/);
  assert.match(modalSource, /不调用 ZCode 接口/);
  assert.match(modalSource, /模型.*MCP.*命令工具.*内置浏览器.*setting\.json/s);
  assert.match(modalSource, /不会改写系统.*代理/s);
  assert.match(modalSource, /不会创建.*TUN/s);
  assert.match(modalSource, /订阅.*YAML.*单节点/s);
  assert.match(modalSource, /实时应用/);
  assert.match(modalSource, /下次启动/);
  assert.match(modalSource, /response\.apply/);
  assert.match(modalSource, /accountsAPI\.rotateZcodeEgress\(account\.accountRef\)/);
  assert.match(modalSource, /立即换一个节点/);
  assert.match(modalSource, /runtime\.health/);
  assert.doesNotMatch(modalSource, /Electron\/Chromium.*启动参数/s);
  assert.match(modalSource, /绑定.*无法解析.*连通性探测.*阻止启动.*保留现有设置/s);
  assert.match(modalSource, /绑定记录无法读取.*阻止启动.*保留现有设置/s);
  assert.match(modalSource, /marker 无法识别.*阻止启动.*保留现有设置/s);
  assert.doesNotMatch(modalSource, /释放 AIH 上次托管值|回到直连|fail-open/i);
  assert.doesNotMatch(modalSource, /关闭后从 AIH 重新打开|Proxy Pool 节点/);
  assert.match(modalSource, /用户手工设置不变/);
  assert.doesNotMatch(modalSource, /Anthropic/i);
  assert.doesNotMatch(modalSource, /Mihomo/i);
  assert.doesNotMatch(modalSource, /\bAlert\b|borderLeft|border-left/);
});

test('ZCode 出口弹窗提供手动分组 CRUD 与自动组策略调整', () => {
  assert.equal(fs.existsSync(groupManagerPath), true, '代理分组管理组件尚未实现');
  const modalSource = fs.readFileSync(modalPath, 'utf8');
  const managerSource = fs.readFileSync(groupManagerPath, 'utf8');

  assert.match(modalSource, /<ZcodeProxyGroupManagerModal/);
  assert.match(managerSource, /proxyPoolAPI\.listGroups\(\)/);
  assert.match(managerSource, /proxyPoolAPI\.upsertGroup\(/);
  assert.match(managerSource, /proxyPoolAPI\.updateGroupPolicy\(/);
  assert.match(managerSource, /proxyPoolAPI\.deleteGroup\(/);
  assert.match(managerSource, /新建手动组/);
  assert.match(managerSource, /自动组成员.*只调整调度策略/s);
  assert.doesNotMatch(managerSource, /\bAlert\b|borderLeft|border-left|Mihomo/i);
});

test('ZCode 出口弹窗捕获表单校验拒绝，不留下未处理 Promise', () => {
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /try\s*\{\s*values\s*=\s*await form\.validateFields\(\)/s);
});

test('ZCode 出口 API 使用账号作用域路由并编码 accountRef', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');

  assert.match(apiSource, /getZcodeEgress:\s*async\s*\(accountRef: string\)/);
  assert.match(apiSource, /saveZcodeEgress:\s*async\s*\(/);
  assert.match(apiSource, /rotateZcodeEgress:\s*async\s*\(accountRef: string\)/);
  assert.match(apiSource, /\/webui\/accounts\/zcode\/\$\{encodeURIComponent\(accountRef\)\}\/egress/);
  assert.match(apiSource, /\/egress\/rotate/);
  assert.match(apiSource, /listGroups:\s*async\s*\(\)/);
  assert.match(apiSource, /upsertGroup:\s*async\s*\(/);
  assert.match(apiSource, /updateGroupPolicy:\s*async\s*\(/);
  assert.match(apiSource, /deleteGroup:\s*async\s*\(/);
});

test('ZCode 出口类型包含五种模式、分组和实时应用结果', () => {
  const typesSource = fs.readFileSync(path.join(projectRoot, 'web/src/types/index.ts'), 'utf8');

  assert.match(typesSource, /ZcodeEgressMode\s*=\s*'system'\s*\|\s*'tun'\s*\|\s*'url'\s*\|\s*'node'\s*\|\s*'group'/);
  assert.match(typesSource, /groupId:\s*string/);
  assert.match(typesSource, /apply\?:\s*ZcodeEgressApplyResult/);
  assert.match(typesSource, /runtime\?:\s*ZcodeEgressRuntimeStatus/);
  assert.match(typesSource, /canRotate:\s*boolean/);
  assert.match(typesSource, /health:\s*ZcodeEgressHealthStatus/);
  assert.match(typesSource, /status\?:\s*'pending_launch'\s*\|\s*'selected'\s*\|\s*'started'\s*\|\s*'restarted'/);
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
