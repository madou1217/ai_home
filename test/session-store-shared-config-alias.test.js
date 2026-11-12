'use strict';

// 2026-11-03 真机事故：`aih codebuddycn 3` 起不来，直接报
//
//   [aih] root router failed:
//   provider_resource_reconcile_incomplete:settings.json,statusline-command.sh,argv.json
//
// 根因是**同一份共享配置的两种规范拼写**被判成两种东西：
//   - reconcile 的存储路径是 provider 根：~/.codebuddy-cn/settings.json
//   - 但国内站根本身是规范实体的宿主链接：~/.codebuddy-cn/settings.json -> ~/.codebuddy/settings.json
//   - 登录/首启的 linkSharedConfigForProjection 直接把投影链接到规范实体 ~/.codebuddy/...
// 旧实现只比较链接**字面**目标，于是后一种链接不算受管链接，整个账号 fail-closed。
//
// 这里钉住矩阵：两种拼写都必须放行；指向无关文件的链接仍必须 fail-closed。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { createSessionStoreService } = require('../lib/cli/services/session-store');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const SHARED_ENTRIES = ['settings.json', 'statusline-command.sh', 'argv.json'];

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shared-config-alias-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeService(home) {
  return createSessionStoreService({
    fs,
    fse,
    path,
    processObj: { platform: 'darwin' },
    aiHomeDir: path.join(home, '.ai_home'),
    hostHomeDir: home,
    cliConfigs: { codebuddycn: { globalDir: '.codebuddy-cn' } },
    getProfileDir: (provider, id) => path.join(home, '.ai_home', 'run', 'auth-projections', provider, id),
    ensureDir: (directoryPath) => fs.mkdirSync(directoryPath, { recursive: true })
  });
}

// 宿主：规范实体在 ~/.codebuddy，国内站根是它的链接（codebuddy-shared-config 的落盘形态）。
function seedHostSharedConfig(home) {
  const canonicalRoot = path.join(home, '.codebuddy');
  const cnRoot = path.join(home, '.codebuddy-cn');
  fs.mkdirSync(canonicalRoot, { recursive: true });
  fs.mkdirSync(cnRoot, { recursive: true });
  for (const entry of SHARED_ENTRIES) {
    const canonical = path.join(canonicalRoot, entry);
    fs.writeFileSync(canonical, entry === 'settings.json' ? '{}\n' : '# shared\n');
    fs.symlinkSync(canonical, path.join(cnRoot, entry));
  }
}

function projectionRoot(home) {
  return path.join(home, '.ai_home', 'run', 'auth-projections', 'codebuddycn', ACCOUNT_REF);
}

// targetRoot 决定投影链接写到哪个字面路径：规范实体（登录/首启路径）或 provider 根
// （reconcile 路径）。两者必须被视为同一条受管链接。
function seedProjection(home, targetRootName) {
  const root = projectionRoot(home);
  const configDir = path.join(root, '.codebuddy-cn');
  fs.mkdirSync(configDir, { recursive: true });
  for (const entry of SHARED_ENTRIES) {
    fs.symlinkSync(path.join(home, targetRootName, entry), path.join(configDir, entry));
  }
  return root;
}

function assertLinksResolveToCanonical(home) {
  const configDir = path.join(projectionRoot(home), '.codebuddy-cn');
  for (const entry of SHARED_ENTRIES) {
    assert.equal(
      fs.realpathSync(path.join(configDir, entry)),
      fs.realpathSync(path.join(home, '.codebuddy', entry)),
      entry
    );
  }
}

test('投影直指规范实体（~/.codebuddy）也算受管共享配置，不再 fail-closed', (t) => {
  const home = makeHome(t);
  seedHostSharedConfig(home);
  const root = seedProjection(home, '.codebuddy');

  const summary = makeService(home).ensureSessionStoreLinks('codebuddycn', ACCOUNT_REF, {
    projectionRoot: root
  });

  assert.deepEqual(summary.unresolved || [], []);
  // 放行不等于重建：链接保持原样，仍指向同一份物理文件。
  assertLinksResolveToCanonical(home);
});

test('投影走 provider 根（~/.codebuddy-cn）同样放行（既有形态不回归）', (t) => {
  const home = makeHome(t);
  seedHostSharedConfig(home);
  const root = seedProjection(home, '.codebuddy-cn');

  const summary = makeService(home).ensureSessionStoreLinks('codebuddycn', ACCOUNT_REF, {
    projectionRoot: root
  });

  assert.deepEqual(summary.unresolved || [], []);
  assertLinksResolveToCanonical(home);
});

test('指向无关文件的同名链接仍然是 unresolved（fail-closed 不变）', (t) => {
  const home = makeHome(t);
  seedHostSharedConfig(home);
  const root = seedProjection(home, '.codebuddy');
  const elsewhere = path.join(home, 'elsewhere.json');
  fs.writeFileSync(elsewhere, '{}\n');
  // 只有 settings.json 被换成外部链接；另外两条保持合法。
  const settingsLink = path.join(root, '.codebuddy-cn', 'settings.json');
  fs.unlinkSync(settingsLink);
  fs.symlinkSync(elsewhere, settingsLink);

  const summary = makeService(home).ensureSessionStoreLinks('codebuddycn', ACCOUNT_REF, {
    projectionRoot: root
  });

  assert.deepEqual(summary.unresolved, ['settings.json']);
  assert.equal(fs.realpathSync(settingsLink), fs.realpathSync(elsewhere));
});
