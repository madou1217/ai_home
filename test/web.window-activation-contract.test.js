'use strict';

// 前后端契约：窗口激活的 WebUI 控制面接线必须与后端路由/存储一致。
// 这些断言锁住「账号菜单 → 弹窗 → API → 路由」这条链，避免改名后静默失效。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const apiPath = path.join(projectRoot, 'web/src/services/api.ts');
const typesPath = path.join(projectRoot, 'web/src/types/index.ts');
const modalPath = path.join(projectRoot, 'web/src/features/accounts/AccountWindowActivationModal.tsx');
const actionsPath = path.join(projectRoot, 'web/src/features/accounts/use-account-actions.ts');
const presentationPath = path.join(projectRoot, 'web/src/features/accounts/window-activation-presentation.ts');
const routePath = path.join(projectRoot, 'lib/server/webui-window-activation-routes.js');

test('账号菜单为支持的 provider 打开窗口激活弹窗', () => {
  assert.equal(fs.existsSync(modalPath), true, '窗口激活必须拆到独立受控组件');
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');

  assert.match(accountsSource, /import \{ AccountWindowActivationModal \} from '@\/features\/accounts\/AccountWindowActivationModal'/);
  assert.match(accountsSource, /key: 'window-activation'/);
  assert.match(accountsSource, /setAccountWindowActivationAccount\(record\)/);
  assert.match(accountsSource, /<AccountWindowActivationModal/);
  assert.match(accountsSource, /accountWindowActivationAccount/);
});

test('弹窗读写走 accountsAPI，间隔留空表示跟随默认', () => {
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /accountsAPI\.getAccountWindowActivation\(account\.provider, account\.accountRef\)/);
  assert.match(modalSource, /accountsAPI\.saveAccountWindowActivation\(account\.provider, account\.accountRef/);
  assert.match(modalSource, /intervalMs/);
  assert.match(modalSource, /跟随全局默认间隔/);
  assert.match(modalSource, /try\s*\{\s*values\s*=\s*await form\.validateFields\(\)/s);
});

test('API 使用 provider 与账号双重作用域并编码路径参数', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');

  assert.match(apiSource, /getAccountWindowActivation:\s*async\s*\(\s*provider: string,\s*accountRef: string\s*\)/);
  assert.match(apiSource, /saveAccountWindowActivation:\s*async\s*\(/);
  assert.match(apiSource, /encodeURIComponent\(provider\).*encodeURIComponent\(accountRef\).*\/window-activation/s);
});

test('类型定义包含开关与可空间隔', () => {
  const typesSource = fs.readFileSync(typesPath, 'utf8');

  assert.match(typesSource, /interface AccountWindowActivationSetting\b/);
  assert.match(typesSource, /intervalMs:\s*number \| null/);
  assert.match(typesSource, /interface AccountWindowActivationResponse\b/);
});

test('窗口激活入口按服务端能力判定，前端不写 provider 清单', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  const statePath = path.join(projectRoot, 'web/src/features/accounts/account-state.ts');
  const livePath = path.join(projectRoot, 'lib/server/webui-account-live.js');

  // 前端只消费服务端结论（account.windowActivationSupported）。
  assert.match(accountsSource, /canConfigureWindowActivation/);
  assert.equal(/provider === 'codex'/.test(accountsSource), false, '前端不得硬编码 provider 清单');
  const stateSource = fs.readFileSync(statePath, 'utf8');
  assert.match(stateSource, /export function canConfigureWindowActivation\(/);
  assert.match(stateSource, /record\.windowActivationSupported === true/);

  // 服务端判定唯一来源是探测规格注册表（新增 provider = 加一条 spec）。
  const liveSource = fs.readFileSync(livePath, 'utf8');
  assert.match(liveSource, /windowActivationSupported: Boolean\(getProbeSpec\(provider\)\)/);
  assert.match(liveSource, /require\('\.\/window-activation\/probe-specs'\)/);
});

test('弹窗只保留可执行信息，不放整段说明文案', () => {
  const modalSource = fs.readFileSync(modalPath, 'utf8');
  assert.equal(/部分账号（如 Codex Plus）/.test(modalSource), false);
  assert.equal(/探测走网关数据面/.test(modalSource), false);
});

test('弹窗状态在账号动作 hook 中集中管理', () => {
  const actionsSource = fs.readFileSync(actionsPath, 'utf8');
  assert.match(actionsSource, /accountWindowActivationAccount/);
  assert.match(actionsSource, /setAccountWindowActivationAccount/);
});

test('弹窗显示全局闸门状态与上次探测（逐账号开关之外还有全局 opt-in）', () => {
  assert.equal(fs.existsSync(presentationPath), true, '全局状态展示必须拆到纯函数模块');
  const modalSource = fs.readFileSync(modalPath, 'utf8');

  assert.match(modalSource, /describeWindowActivationGlobal\(/);
  assert.match(modalSource, /setGlobalState\(response\.global/);
  assert.match(modalSource, /setLastProbe\(response\.lastProbe/);
  // 逐账号开关打开但全局没生效时必须当场说清楚，不能静默保存。
  assert.match(modalSource, /全局开关未生效/);
  // 默认间隔提示必须来自真实运行态，不能写死。
  assert.match(modalSource, /formatWindowActivationInterval\(globalState\?\.defaultIntervalMs\)/);
});

test('路由把全局闸门状态与上次探测一起下发', () => {
  const routeSource = fs.readFileSync(routePath, 'utf8');
  assert.match(routeSource, /global: readGlobalState\(ctx, aiHomeDir\)/);
  assert.match(routeSource, /lastProbe: readProbeState\(ctx, aiHomeDir, accountRef\)/);
  assert.match(routeSource, /function presentGlobalState\(/);

  const typesSource = fs.readFileSync(typesPath, 'utf8');
  assert.match(typesSource, /interface AccountWindowActivationGlobalState\b/);
  assert.match(typesSource, /interface AccountWindowActivationProbeState\b/);
});

test('全局开关有正规入口：server config → serve args → 调度器运行态', () => {
  // 只有逐账号开关、没有全局入口时，账号页打开开关也不会探测 —— 这条链少一环就回到那个 bug。
  const storeSource = fs.readFileSync(path.join(projectRoot, 'lib/server/server-config-store.js'), 'utf8');
  assert.match(storeSource, /windowActivation: false/);
  assert.match(storeSource, /if \(normalized\.windowActivation\) args\.push\('--window-activation'\)/);

  const commandSource = fs.readFileSync(path.join(projectRoot, 'lib/server/server-config-command.js'), 'utf8');
  assert.match(commandSource, /flag === '--window-activation'/);
  assert.match(commandSource, /flag === '--no-window-activation'/);

  // serve 侧必须能接住保存配置下发的 flag。
  const argsSource = fs.readFileSync(path.join(projectRoot, 'lib/server/args.js'), 'utf8');
  assert.match(argsSource, /arg === '--window-activation'/);

  // WebUI 要能读到「当前生效」的运行态（而不是只读保存值）。
  const serverSource = fs.readFileSync(path.join(projectRoot, 'lib/server/server.js'), 'utf8');
  assert.match(serverSource, /getWindowActivationState: \(\) => \(windowActivationScheduler/);
});
