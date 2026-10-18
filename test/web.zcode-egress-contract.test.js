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

test('账号出口弹窗提供出口池、代理地址、系统代理、外部 TUN 四种来源', () => {
  assert.equal(fs.existsSync(modalPath), true, '出口设置弹窗尚未实现');
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /accountsAPI\.getAccountEgress\(account\.provider, account\.accountRef\)/);
  assert.match(modalSource, /accountsAPI\.saveAccountEgress\(account\.provider, account\.accountRef/);
  assert.match(modalSource, /proxyUrl:\s*values\.mode === 'url' \? String\(values\.proxyUrl/);
  // 四种来源由数据驱动渲染（value/label 表），断言表里确实含这四项。
  const sourceTable = modalSource.match(/\[([\s\S]*?)\]\s*as const\)\.map/);
  assert.ok(sourceTable, '来源表必须存在');
  for (const mode of ['system', 'tun', 'url', 'pool']) {
    assert.match(sourceTable[1], new RegExp(`\\['${mode}',`), mode);
  }
  // node / group 仍然下线（依赖 AIH 自开的本地代理端口）；pool 是 2026-10-17 重新启用的
  // 出口池（本地出站端口由 AIH 维护，绑定只记「用池」）。
  assert.doesNotMatch(modalSource, /\['(node|group)',/, '节点 / 分组出口已下线');
  // 说明文案收进各选项的 info 气泡，不再常驻正文；关键事实仍然保留在气泡里。
  assert.match(modalSource, /function EgressHint/);
  assert.match(modalSource, /<InfoCircleOutlined \/>/);
  // 每个来源瓷砖只挂一个 info 图标，内容取自同一张按 mode 索引的说明表（四种来源都必须有说明）。
  assert.match(modalSource, /<EgressHint title=\{label\}>\{sourceHints\[value\]\}<\/EgressHint>/);
  const hintTable = modalSource.match(/const sourceHints: Record<AccountEgressMode, ReactNode> = \{([\s\S]*?)\n  \};/);
  assert.ok(hintTable, '来源说明表必须存在');
  for (const mode of ['pool', 'url', 'system', 'tun']) {
    assert.match(hintTable[1], new RegExp(`\\n    ${mode}: `), `${mode} 缺少说明`);
  }
  // 图标点击只开气泡、不改变选中项；可键盘操作并带无障碍名称。
  assert.match(modalSource, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(modalSource, /role="button"[\s\S]{0,80}tabIndex=\{0\}[\s\S]{0,80}aria-label=/);
  // 已删除的常驻说明墙：正文不再有说明段落/描述行。
  assert.doesNotMatch(modalSource, /egress-intro|aih-choice-tile-desc/);
  const overlaysCss = fs.readFileSync(path.join(projectRoot, 'web/src/features/accounts/account-overlays.css'), 'utf8');
  // 图标必须有可见尺寸，不能退回到「跟在文字后面的灰色小点」。
  assert.match(overlaysCss, /\.egress-hint-trigger \{[^}]*width: 22px;[^}]*height: 22px;/);
  // 总说明不能与出口池矛盾：只有出口池运行内核、开回环端口，其它来源不开本地端口。
  assert.doesNotMatch(modalSource, /AIH 不运行代理内核、不开本地端口/);
  assert.match(modalSource, /只有选择「AIH 出口池」时才会运行代理内核/);
  assert.match(modalSource, /其它来源都不开本地端口/);
  // info 图标键盘可操作：Enter/Space 显式切换受控的气泡开合（span 不会合成 click）。
  assert.match(modalSource, /open=\{open\}/);
  assert.match(modalSource, /onOpenChange=\{setOpen\}/);
  assert.match(modalSource, /setOpen\(\(current\) => !current\)/);
  assert.match(modalSource, /aria-expanded=\{open\}/);
  // 代理地址支持 SOCKS5（网关侧由 socks5-connector 建隧道）；ZCode 的原生 httpProxy
  // 只认 HTTP(S)，因此说明按 provider 分叉而不是一刀切说「不支持 SOCKS」。
  assert.match(modalSource, /socks5:\/\/host:port/);
  assert.match(modalSource, /只认 HTTP\(S\)/);
  assert.match(modalSource, /setting\.json/);
  assert.match(modalSource, /中性连通性地址/);
  assert.match(modalSource, /不调用任何 provider 接口/);
  assert.match(modalSource, /不会改写系统代理/);
  assert.match(modalSource, /不创建、不启停/);
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

test('账号出口类型含出口池模式，并能表达已下线绑定与解析后的运行态', () => {
  const typesSource = fs.readFileSync(path.join(projectRoot, 'web/src/types/index.ts'), 'utf8');

  assert.match(typesSource, /AccountEgressMode\s*=\s*'system'\s*\|\s*'tun'\s*\|\s*'url'\s*\|\s*'pool';/);
  // node / group 仍是历史模式（只读展示、提示改绑）；pool 已重新启用，不再属于 retired。
  assert.match(typesSource, /RetiredAccountEgressMode\s*=\s*'node'\s*\|\s*'group';/);
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
