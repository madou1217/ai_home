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

// 需要重新登录的账号只给两个操作：重新登录，以及与登录态无关的调度规则编辑。
const REAUTH_ROW_ACTIONS = ['reauth', 'routing-rules'];

/** 取出某个操作构建函数里「需要重新登录」分支返回的操作 key（按书写顺序）。 */
function reauthBranchActionKeys(source, functionName) {
  const start = source.indexOf(`const ${functionName} = (record: Account)`);
  assert.notEqual(start, -1, `${functionName} is missing`);
  const branch = source.slice(start).match(/if \(requiresAccountReauth\(record\)\) \{\s*return \[([\s\S]*?)\];\s*\}/);
  assert.ok(branch, `${functionName} must return a fixed action list for reauth-required accounts`);
  return [...branch[1].matchAll(/key: '([^']+)'/g)].map((match) => match[1]);
}

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

test('reauth-required rows are distinguished inline and expose only reauth and routing rules', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  const badgesSource = fs.readFileSync(accountBadgesPath, 'utf8');
  const mobileSource = fs.readFileSync(mobileAccountsPath, 'utf8');
  // 桌面菜单、桌面点击守卫与移动端左滑操作三处一致。
  assert.deepEqual(reauthBranchActionKeys(accountsSource, 'buildAccountMenuItems'), REAUTH_ROW_ACTIONS);
  assert.match(accountsSource, /if \(requiresAccountReauth\(record\) && key !== 'reauth' && key !== 'routing-rules'\) return;/);
  assert.deepEqual(reauthBranchActionKeys(mobileSource, 'buildPrimaryActions'), REAUTH_ROW_ACTIONS);
  assert.match(accountsSource, /requiresAccountReauth\(record\) \? \(/);
  assert.match(accountsSource, /disabled=\{requiresReauth/);
  assert.match(badgesSource, /text="需要重新登录"/);
  assert.doesNotMatch(accountsSource, /RecoveryAccountsDrawer|recoveryDrawerOpen/);
  legacyRecoveryDrawerPaths.forEach((legacyPath) => {
    assert.equal(fs.existsSync(legacyPath), false, `${path.basename(legacyPath)} must stay removed`);
  });
});
