const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const accountBadgesPath = path.join(projectRoot, 'web/src/features/accounts/AccountBadges.tsx');
const mobileAccountsPath = path.join(projectRoot, 'web/src/mobile/pages/MobileAccounts.tsx');
const recoveryViewPath = path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsView.tsx');
const recoveryViewStylePath = path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsView.css');
const legacyRecoveryDrawerPaths = [
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.tsx'),
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.css')
];
const routesPath = path.join(projectRoot, 'web/config/routes.ts');

// 需要重新登录的账号只给一个操作：重新登录。调度规则是第三方/自建上游的 API Key 账号
// 专属（OAuth 与官方地址账号走厂商标准错误码），登录态账号没有这个入口。
const REAUTH_ROW_ACTIONS = ['reauth'];

/** 取出某个操作构建函数里「需要重新登录」分支返回的操作 key（按书写顺序）。 */
function reauthBranchActionKeys(source, functionName) {
  const start = source.indexOf(`const ${functionName} = (record: Account)`);
  assert.notEqual(start, -1, `${functionName} is missing`);
  const branch = source.slice(start).match(/if \(requiresAccountReauth\(record\)\) \{\s*return \[([\s\S]*?)\];\s*\}/);
  assert.ok(branch, `${functionName} must return a fixed action list for reauth-required accounts`);
  return [...branch[1].matchAll(/key: '([^']+)'/g)].map((match) => match[1]);
}

test('account level restore-scheduling is wired on every surface through one predicate', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  const mobileSource = fs.readFileSync(mobileAccountsPath, 'utf8');
  const detailSheetSource = fs.readFileSync(
    path.join(projectRoot, 'web/src/mobile/pages/accounts/AccountDetailSheet.tsx'), 'utf8');
  const actionsSource = fs.readFileSync(
    path.join(projectRoot, 'web/src/features/accounts/use-account-actions.ts'), 'utf8');
  const apiSource = fs.readFileSync(path.join(projectRoot, 'web/src/services/api.ts'), 'utf8');
  const routerSource = fs.readFileSync(path.join(projectRoot, 'lib/server/web-ui-router.js'), 'utf8');
  const stateSource = fs.readFileSync(
    path.join(projectRoot, 'web/src/features/accounts/account-state.ts'), 'utf8');
  // 入口判定只有一份（account-state 的 canRestoreAccountScheduling），三处 UI 都消费它。
  assert.match(stateSource, /export function canRestoreAccountScheduling\(/);
  assert.match(accountsSource, /if \(canRestoreAccountScheduling\(record\)\) \{\s*menuItems\.push\(\{ key: 'restore-scheduling'/);
  assert.match(mobileSource, /if \(canRestoreAccountScheduling\(record\)\) \{\s*list\.push\(\{\s*key: 'restore-scheduling'/);
  assert.match(detailSheetSource, /if \(canRestoreAccountScheduling\(record\)\) \{\s*sheetActions\.push\(\{\s*key: 'restore-scheduling'/);
  assert.match(accountsSource, /if \(key === 'restore-scheduling'\) \{ handleRestoreScheduling\(record\); return; \}/);
  // 动作走人工覆盖语义（manual_admin_clear 由服务端门禁负责），并复用同一个 API。
  assert.match(actionsSource, /const handleRestoreScheduling = \(record: Account\) => \{[\s\S]*?accountsAPI\.restoreScheduling\(/);
  assert.match(apiSource, /restoreScheduling: async \(provider: string, accountRef: string\)[\s\S]*?\/restore-scheduling`/);
  assert.match(routerSource, /restore-scheduling\$\/\)/);
  assert.match(routerSource, /await handleRestoreAccountSchedulingRequest\(routeCtx\)/);
});

test('accounts page keeps every non-deleted account in the single management list', () => {
  const source = fs.readFileSync(accountsPath, 'utf8');
  const routes = fs.readFileSync(routesPath, 'utf8');
  assert.match(source, /useTokenDropEvents\(accounts[,)]/);
  assert.match(source, /useModelCatalog\(accounts\)/);
  assert.match(source, /accounts\.forEach\(account =>/);
  assert.match(source, /let filtered = accounts;/);
  assert.doesNotMatch(source, /partitionAccountsByRecovery|currentAccounts|recoveryAccounts/);
  assert.doesNotMatch(source, /RecoveryAccountsView|待恢复|\/accounts\/recovery/);
  assert.doesNotMatch(routes, /\/accounts\/recovery/);
  assert.equal(fs.existsSync(recoveryViewPath), false);
  assert.equal(fs.existsSync(recoveryViewStylePath), false);
});

test('reauth-required rows are distinguished inline and expose only reauth', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  const badgesSource = fs.readFileSync(accountBadgesPath, 'utf8');
  const mobileSource = fs.readFileSync(mobileAccountsPath, 'utf8');
  const detailSheetPath = path.join(projectRoot, 'web/src/mobile/pages/accounts/AccountDetailSheet.tsx');
  const detailSheetSource = fs.readFileSync(detailSheetPath, 'utf8');
  // 桌面菜单、桌面点击守卫与移动端左滑操作三处一致。
  assert.deepEqual(reauthBranchActionKeys(accountsSource, 'buildAccountMenuItems'), REAUTH_ROW_ACTIONS);
  assert.match(accountsSource, /if \(requiresAccountReauth\(record\) && key !== 'reauth'\) return;/);
  assert.deepEqual(reauthBranchActionKeys(mobileSource, 'buildPrimaryActions'), REAUTH_ROW_ACTIONS);
  assert.match(accountsSource, /requiresAccountReauth\(record\) \? \(/);
  assert.match(accountsSource, /disabled=\{requiresReauth/);
  assert.match(badgesSource, /text="需要重新登录"/);
  assert.doesNotMatch(accountsSource, /RecoveryAccountsDrawer|recoveryDrawerOpen/);
  // 调度规则入口只由「第三方/自建上游的 API Key 账号」判定放行，三处 UI 都不得无条件渲染。
  assert.match(accountsSource, /if \(canEditAccountRoutingRules\(record\)\) \{\s*menuItems\.push\(\{ key: 'routing-rules'/);
  assert.match(mobileSource, /if \(canEditAccountRoutingRules\(record\)\) \{\s*list\.push\(\{ key: 'routing-rules'/);
  assert.match(detailSheetSource, /if \(canEditAccountRoutingRules\(record\)\) \{\s*sheetActions\.push\(\{\s*key: 'routing-rules'/);
  legacyRecoveryDrawerPaths.forEach((legacyPath) => {
    assert.equal(fs.existsSync(legacyPath), false, `${path.basename(legacyPath)} must stay removed`);
  });
});
