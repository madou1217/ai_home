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

test('弹窗状态在账号动作 hook 中集中管理', () => {
  const actionsSource = fs.readFileSync(actionsPath, 'utf8');
  assert.match(actionsSource, /accountWindowActivationAccount/);
  assert.match(actionsSource, /setAccountWindowActivationAccount/);
});
