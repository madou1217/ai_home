'use strict';

// 回归守卫（用户 2026-10-31）：「Do you trust the files in this folder?」只答一次。
//
// CLI 把回答写进 <configDir>/settings.json 的 trustedDirectories，而每个 aih 账号
// 有自己的投影 configDir —— 同一目录换个账号就再问一遍。这里守两件事：
//   1) 家族里任何一份 settings 已经信任过这个目录，启动时就补给本次 configDir；
//   2) 没信任过就什么都不写（第一次进新目录仍然由用户回答）。
// 另外守 pattern 匹配：只认 CLI 自己会写的形态，看不懂的 glob 一律当不匹配。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  familyConfigDirNames,
  listFamilySettingsPaths,
  matchesTrustedDirectory,
  findInheritedTrustPattern,
  seedInheritedFolderTrust
} = require('../lib/runtime/codebuddy-folder-trust');

function withHome(t, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-folder-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(hostHomeDir, { recursive: true });
  fs.mkdirSync(aiHomeDir, { recursive: true });
  return fn({ root, hostHomeDir, aiHomeDir });
}

function writeSettings(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readSettings(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('pattern 匹配只认 CLI 自己写的形态', () => {
  assert.equal(matchesTrustedDirectory('/Users/me/proj', '/Users/me/proj'), true);
  assert.equal(matchesTrustedDirectory('/Users/me/proj/', '/Users/me/proj'), true);
  assert.equal(matchesTrustedDirectory('/Users/me/proj/**', '/Users/me/proj'), true);
  assert.equal(matchesTrustedDirectory('/Users/me/proj/**', '/Users/me/proj/sub'), true);
  assert.equal(matchesTrustedDirectory('/Users/me/**', '/Users/me/proj'), true);
  assert.equal(matchesTrustedDirectory('/Users/me/**', '/Users/other'), false);
  assert.equal(matchesTrustedDirectory('**', '/anywhere'), true);
  // 看不懂的 glob 当成"没匹配"：宁可多问一次，也不扩散授权。
  assert.equal(matchesTrustedDirectory('/Users/*/proj', '/Users/me/proj'), false);
  assert.equal(matchesTrustedDirectory('', '/Users/me/proj'), false);
});

test('配置根名单来自家族布局表，四个成员都在', () => {
  assert.deepEqual(
    [...familyConfigDirNames()].sort(),
    ['.codebuddy', '.codebuddy-cn', '.workbuddy', '.workbuddy-ai'].sort()
  );
});

test('settings 来源同时包含宿主配置根与账号投影', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  writeSettings(path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_1', '.codebuddy-cn', 'settings.json'), {});
  const paths = listFamilySettingsPaths({ fs, path, hostHomeDir, aiHomeDir });
  assert.ok(paths.includes(path.join(hostHomeDir, '.codebuddy', 'settings.json')));
  assert.ok(paths.includes(path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_1', '.codebuddy-cn', 'settings.json')));
}));

test('别的账号已经信任过：本次 configDir 自动继承同一条 pattern', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  const cwd = '/Users/me/proj';
  writeSettings(
    path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddy', 'acct_intl', '.codebuddy', 'settings.json'),
    { trustedDirectories: ['/Users/me/**'], model: 'x' }
  );
  const configDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_cn', '.codebuddy-cn');
  writeSettings(path.join(configDir, 'settings.json'), { model: 'deepseek' });

  const result = seedInheritedFolderTrust({ fs, path, configDir, directory: cwd, hostHomeDir, aiHomeDir });

  assert.equal(result.changed, true);
  assert.equal(result.pattern, '/Users/me/**');
  const settings = readSettings(path.join(configDir, 'settings.json'));
  assert.deepEqual(settings.trustedDirectories, ['/Users/me/**']);
  assert.equal(settings.model, 'deepseek');
}));

test('已经信任过就什么都不写（幂等）', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  const cwd = '/Users/me/proj';
  const configDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_cn', '.codebuddy-cn');
  writeSettings(path.join(configDir, 'settings.json'), { trustedDirectories: ['/Users/me/proj'] });
  const before = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8');

  const result = seedInheritedFolderTrust({ fs, path, configDir, directory: cwd, hostHomeDir, aiHomeDir });

  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'), before);
}));

test('家族里没人信任过这个目录：不写文件（第一次仍由用户回答）', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  const configDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddy', 'acct_x', '.codebuddy');
  const result = seedInheritedFolderTrust({ fs, path, configDir, directory: '/Users/me/fresh', hostHomeDir, aiHomeDir });

  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
}));

test('宿主 WorkBuddy 侧做过的决定同样会被继承（跨站点、跨产品）', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  writeSettings(path.join(hostHomeDir, '.workbuddy-ai', 'settings.json'), { trustedDirectories: ['/Users/me/work/**'] });
  const configDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_cn', '.codebuddy-cn');

  assert.equal(findInheritedTrustPattern({ fs, path, hostHomeDir, aiHomeDir, directory: '/Users/me/work/x' }), '/Users/me/work/**');
  const result = seedInheritedFolderTrust({ fs, path, configDir, directory: '/Users/me/work/x', hostHomeDir, aiHomeDir });

  assert.equal(result.changed, true);
  assert.deepEqual(readSettings(path.join(configDir, 'settings.json')).trustedDirectories, ['/Users/me/work/**']);
}));

test('启动策略 prepare 会把继承来的信任写进本次 configDir', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  const { prepare } = require('../lib/cli/services/ai-cli/launch-profile/codebuddy-strategy');
  const cwd = '/Users/me/proj';
  writeSettings(
    path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddy', 'acct_intl', '.codebuddy', 'settings.json'),
    { trustedDirectories: ['/Users/me/proj'] }
  );
  const sandboxDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_cn');

  prepare({ fs, path, cliName: 'codebuddycn', sandboxDir, hostHomeDir, aiHomeDir, cwd });

  const settings = readSettings(path.join(sandboxDir, '.codebuddy-cn', 'settings.json'));
  assert.deepEqual(settings.trustedDirectories, ['/Users/me/proj']);
}));

test('多个账号都信任过时，继承最窄的那一条（不扩散放大授权）', (t) => withHome(t, ({ hostHomeDir, aiHomeDir }) => {
  writeSettings(
    path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddy', 'acct_wide', '.codebuddy', 'settings.json'),
    { trustedDirectories: ['/Users/**'] }
  );
  writeSettings(
    path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddy', 'acct_narrow', '.codebuddy', 'settings.json'),
    { trustedDirectories: ['/Users/me/proj/**'] }
  );
  writeSettings(path.join(hostHomeDir, '.workbuddy-ai', 'settings.json'), { trustedDirectories: ['**'] });
  const configDir = path.join(aiHomeDir, 'run', 'auth-projections', 'codebuddycn', 'acct_cn', '.codebuddy-cn');

  const result = seedInheritedFolderTrust({ fs, path, configDir, directory: '/Users/me/proj/sub', hostHomeDir, aiHomeDir });

  assert.equal(result.pattern, '/Users/me/proj/**');
  assert.deepEqual(readSettings(path.join(configDir, 'settings.json')).trustedDirectories, ['/Users/me/proj/**']);
}));
