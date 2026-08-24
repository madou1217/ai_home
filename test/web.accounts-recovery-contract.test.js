const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const accountBadgesPath = path.join(projectRoot, 'web/src/features/accounts/AccountBadges.tsx');
const recoveryViewPath = path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsView.tsx');
const recoveryViewStylePath = path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsView.css');
const legacyRecoveryDrawerPaths = [
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.tsx'),
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.css')
];
const routesPath = path.join(projectRoot, 'web/config/routes.ts');

test('accounts page keeps every non-deleted account in the single management list', () => {
  const source = fs.readFileSync(accountsPath, 'utf8');
  const routes = fs.readFileSync(routesPath, 'utf8');
  assert.match(source, /useTokenDropEvents\(accounts,/);
  assert.match(source, /useModelCatalog\(accounts\)/);
  assert.match(source, /accounts\.forEach\(account =>/);
  assert.match(source, /let filtered = accounts;/);
  assert.doesNotMatch(source, /partitionAccountsByRecovery|currentAccounts|recoveryAccounts/);
  assert.doesNotMatch(source, /RecoveryAccountsView|待恢复|\/accounts\/recovery/);
  assert.doesNotMatch(routes, /\/accounts\/recovery/);
  assert.equal(fs.existsSync(recoveryViewPath), false);
  assert.equal(fs.existsSync(recoveryViewStylePath), false);
});

test('reauth-required rows are distinguished inline and expose reauth as their only action', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  const badgesSource = fs.readFileSync(accountBadgesPath, 'utf8');
  assert.match(accountsSource, /if \(requiresAccountReauth\(record\)\) \{\s*return \[\{ key: 'reauth'/s);
  assert.match(accountsSource, /requiresAccountReauth\(record\) \? \(/);
  assert.match(accountsSource, /disabled=\{requiresReauth/);
  assert.match(badgesSource, /text="需要重新登录"/);
  assert.doesNotMatch(accountsSource, /RecoveryAccountsDrawer|recoveryDrawerOpen/);
  legacyRecoveryDrawerPaths.forEach((legacyPath) => {
    assert.equal(fs.existsSync(legacyPath), false, `${path.basename(legacyPath)} must stay removed`);
  });
});
