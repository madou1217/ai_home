const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const accountsPath = path.join(projectRoot, 'web/src/pages/Accounts.tsx');
const recoveryViewPath = path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsView.tsx');
const legacyRecoveryDrawerPaths = [
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.tsx'),
  path.join(projectRoot, 'web/src/features/accounts/RecoveryAccountsDrawer.css')
];
const routesPath = path.join(projectRoot, 'web/config/routes.ts');

test('accounts page keeps system-retained accounts outside the current pool and links to a recovery page', () => {
  const source = fs.readFileSync(accountsPath, 'utf8');
  const routes = fs.readFileSync(routesPath, 'utf8');
  assert.match(source, /partitionAccountsByRecovery\(accounts\)/);
  assert.match(source, /<RecoveryAccountsView/);
  assert.match(source, /<Badge count=\{recoveryAccounts\.length\}/);
  assert.match(source, /navigate\('\/accounts\/recovery'\)/);
  assert.match(routes, /path: "\/accounts\/recovery"/);
});

test('recovery page explains retention and exposes reauth plus explicit delete actions without a drawer', () => {
  const accountsSource = fs.readFileSync(accountsPath, 'utf8');
  assert.equal(fs.existsSync(recoveryViewPath), true);
  const source = fs.existsSync(recoveryViewPath) ? fs.readFileSync(recoveryViewPath, 'utf8') : '';
  assert.match(source, /账号数据仍然保留/);
  assert.match(source, /重新登录/);
  assert.match(source, /删除账号/);
  assert.doesNotMatch(source, /\bDrawer\b/);
  assert.doesNotMatch(accountsSource, /RecoveryAccountsDrawer|recoveryDrawerOpen/);
  legacyRecoveryDrawerPaths.forEach((legacyPath) => {
    assert.equal(fs.existsSync(legacyPath), false, `${path.basename(legacyPath)} must stay removed`);
  });
});
