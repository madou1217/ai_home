'use strict';

// 前后端契约：账号活动（签到 / 领取试用套餐）的 WebUI 接线必须与 provider 描述符、
// 服务端路由同源。
//
// 守住的核心不变量：**前端与服务端派发都不写 provider 名单**。新增 provider 只加
// 描述符（activity 能力），账号快照自动带出动作，页面自动出现入口。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('账号页把 activityActions 渲染成供应商内容区动作按钮与账号菜单项', () => {
  const page = read('web/src/pages/Accounts.tsx');
  assert.match(page, /import \{ AccountActivityModal \} from '@\/features\/accounts\/AccountActivityModal'/);
  assert.match(page, /for \(const action of record\.activityActions \|\| \[\]\)/);
  assert.match(page, /key: `activity:\$\{action\.id\}`/);
  // 动作只在声明它的供应商内容区出现（“全部”不提供全局入口），且不塞进 tab 栏。
  assert.match(page, /const visibleActivityActions = useMemo/);
  assert.match(page, /if \(activeProvider === 'all'\) return \[\];/);
  assert.match(page, /accounts-activity-bar/);
  // 列表视图把动作放进 ProTable 右侧 toolBarRender，与左侧“可用 n”状态同一行。
  assert.match(page, /toolBarRender=\{\(\) => \(/);
  assert.match(page, /renderProviderActivityActions/);
  assert.doesNotMatch(page, /tabBarExtraContent/);
  // 批量领取是异步任务：开始后轮询进度，不再同步等待全部账号。
  assert.match(page, /accountsAPI\.startAccountActivityJob/);
  assert.match(page, /accountsAPI\.getAccountActivityJob/);
  assert.match(page, /rewardsProgressText/);
  assert.doesNotMatch(page, /runAllAccountActivities/);
  assert.match(page, /<AccountActivityModal[\s\S]*results=\{rewardsResults\}/);
});

test('领取入口按服务端 capability 判定，前端不写 provider 清单', () => {
  const state = read('web/src/features/accounts/account-state.ts');
  assert.match(state, /export function canRunAccountActivity/);
  assert.match(state, /Array\.isArray\(record\.activityActions\)/);

  const page = read('web/src/pages/Accounts.tsx');
  // 页面不得自己判断 provider：领取动作只消费 activityActions / action.id。
  assert.doesNotMatch(page, /provider === 'qoder'/);
  assert.doesNotMatch(page, /provider === 'zcode'/);
});

test('移动端左滑同样消费 activityActions（不新增 provider 判断）', () => {
  const mobile = read('web/src/mobile/pages/MobileAccounts.tsx');
  assert.match(mobile, /canRunAccountActivity/);
  assert.match(mobile, /for \(const action of record\.activityActions \|\| \[\]\)/);
  assert.match(mobile, /accountsAPI\.runAccountActivity\(record\.provider, record\.accountRef, actionId\)/);
});

test('账号快照从描述符能力下发动作清单（唯一下发点）', () => {
  const live = read('lib/server/webui-account-live.js');
  assert.match(live, /const \{ listActivityActions \} = require\('\.\.\/account\/activity-claim'\)/);
  const occurrences = live.match(/activityActions: listActivityActions\(provider\)/g) || [];
  assert.equal(occurrences.length, 2, '快照与实时记录两条构造路径都必须下发');
});

test('服务端路由与 CLI 共用同一条策略执行器', () => {
  const router = read('lib/server/web-ui-router.js');
  assert.match(router, /handleAccountActivityRequest/);
  assert.match(router, /\/v0\/webui\/accounts\/activity\/run/);

  const routes = read('lib/server/webui-account-activity-routes.js');
  assert.match(routes, /runActivityClaim/);
  assert.match(routes, /listActivityActions/);
  assert.match(routes, /account-activity-job-manager/);

  const command = read('lib/cli/services/claim/claim-command.js');
  assert.match(command, /listActivityProviders/);
  assert.match(command, /runActivityClaim/);
});

test('provider 描述符是 activity 动作的唯一声明处', () => {
  const qoder = read('lib/providers/defs/qoder.js');
  const qodercn = read('lib/providers/defs/qodercn.js');
  const zcode = read('lib/providers/defs/zcode.js');
  for (const source of [qoder, qodercn]) {
    assert.match(source, /activity: \{[\s\S]*handler: 'qoder-daily-checkin'/);
  }
  assert.match(zcode, /activity: \{[\s\S]*handler: 'zcode-plan-claim'/);
});
