'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// 回归守卫（2026-11-06）：账号操作菜单不再用「更多」子菜单堆低频动作。
// 同类动作必须合并成一个入口，弹窗内用 Tab 切换；详见 feedback_account_menu_tabs。
test('account menu merges similar actions instead of adding a 更多 submenu', () => {
  const accounts = read('web/src/pages/Accounts.tsx');
  assert.doesNotMatch(accounts, /label: '更多'/);
  assert.doesNotMatch(accounts, /key: 'more'/);
  // 账号配置 = 编辑 + 查看配置文件 + 导出；运行设置 = 出口 + 窗口激活 + 别名选号 + 上下文窗口。
  assert.match(accounts, /key: 'account-config'/);
  assert.match(accounts, /key: 'runtime-settings'/);
  assert.doesNotMatch(accounts, /key: 'config-files'/);
  assert.doesNotMatch(accounts, /key: 'alias-pool'/);
  assert.doesNotMatch(accounts, /key: 'model-context'/);
  assert.doesNotMatch(accounts, /label: '编辑配置'/);
});

test('runtime settings dialog hosts every runtime action as a tab', () => {
  const modal = read('web/src/features/accounts/AccountRuntimeSettingsModal.tsx');
  for (const tab of ['出口设置', '窗口激活', '别名选号', '上下文窗口']) {
    assert.match(modal, new RegExp(`label: '${tab}'`));
  }
  // 四个面板都以 embedded 模式渲染，不再各自弹一层 Modal。
  assert.equal((modal.match(/embedded/g) || []).length >= 4, true);
});

test('account config dialog folds export into the same panel as config files', () => {
  const modal = read('web/src/features/accounts/AccountConfigFilesModal.tsx');
  assert.match(modal, /导出账号/);
  assert.match(modal, /onExport/);
  const edit = read('web/src/features/accounts/EditAccountModal.tsx');
  assert.match(edit, /label: '配置文件'/);
  assert.match(edit, /AccountConfigFilesPanel/);
});
