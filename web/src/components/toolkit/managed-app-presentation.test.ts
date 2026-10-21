import assert from 'node:assert/strict';
import test from 'node:test';

import { getAppAdvancedEntryLabel } from './managed-app-presentation.ts';

// 「高级设置」是 provider 配置的唯一入口（独立的 Provider 配置面板已并入应用管理）。
// 入口说明必须如实说出里面有哪些 tab，否则用户在卡片上只能看到一支没有含义的铅笔。
test('高级设置入口说明按实际存在的 tab 组合', () => {
  assert.equal(getAppAdvancedEntryLabel({ type: 'cli' }, 3), '启动权限 · 配置文件 3 个');
  assert.equal(getAppAdvancedEntryLabel({ type: 'cli' }, 0), '启动权限');
  assert.equal(getAppAdvancedEntryLabel({ type: 'desktop' }, 2), '配置文件 2 个');
  assert.equal(getAppAdvancedEntryLabel({ type: 'ide' }, 0), '高级设置');
});

test('配置文件数量为脏值时按 0 处理，不编造入口', () => {
  assert.equal(getAppAdvancedEntryLabel({ type: 'desktop' }, Number.NaN), '高级设置');
  assert.equal(getAppAdvancedEntryLabel({ type: 'desktop' }, -1), '高级设置');
});
