'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  VERDICTS,
  verifyByIdentity,
  createUpgradeVerifier
} = require('../lib/server/provider-cli-upgrade/upgrade-verifier');
const {
  verifyCodexAppServerBoot
} = require('../lib/server/provider-cli-upgrade/verifiers/codex');
const {
  POST_INSTALL_ACTIONS,
  collectPostInstallActions,
  runPostInstallActions
} = require('../lib/server/provider-cli-upgrade/upgrade-post-install');

function identityDeps(overrides = {}) {
  return {
    resolveCliPath: async () => '/home/u/.local/bin/codex',
    probeVersion: async () => '0.154.0',
    ...overrides
  };
}

test('版本与路径都对上时判 pass', async () => {
  const result = await verifyByIdentity('codex', '0.154.0', identityDeps());
  assert.equal(result.verdict, VERDICTS.PASS);
});

// 这是防影子二进制的那一环：装成功了，但会被启动的是另一份。
test('装完解析到的是别人 → 判 fail(影子二进制)', async () => {
  const result = await verifyByIdentity('codex', '0.154.0', identityDeps({
    expectedOwnerPath: '/opt/codex/releases/0.154.0/bin/codex',
    realpath: () => '/home/u/.bun/bin/codex'
  }));

  assert.equal(result.verdict, VERDICTS.FAIL);
  assert.match(result.detail, /owner_mismatch/);
});

test('版本号对不上判 fail', async () => {
  const result = await verifyByIdentity('codex', '0.154.0', identityDeps({ probeVersion: async () => '0.153.4' }));
  assert.equal(result.verdict, VERDICTS.FAIL);
  assert.match(result.detail, /version_mismatch/);
});

test('装完解析不到任何可执行文件是正向坏消息', async () => {
  const result = await verifyByIdentity('codex', '0.154.0', identityDeps({ resolveCliPath: async () => '' }));
  assert.equal(result.verdict, VERDICTS.FAIL);
  assert.equal(result.detail, 'cli_not_resolved_after_install');
});

// 探针自己出问题不等于版本坏，不能据此回滚。
test('探针失败或拿不到版本号一律 inconclusive', async () => {
  const probeFailed = await verifyByIdentity('codex', '0.154.0', identityDeps({
    probeVersion: async () => { throw new Error('spawn ENOENT'); }
  }));
  assert.equal(probeFailed.verdict, VERDICTS.INCONCLUSIVE);

  const silent = await verifyByIdentity('codex', '0.154.0', identityDeps({ probeVersion: async () => '' }));
  assert.equal(silent.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(silent.detail, 'version_unreported');
});

test('同一性断言不过时不再跑强判据', async () => {
  let strongCalled = false;
  const verify = createUpgradeVerifier({
    ...identityDeps({ probeVersion: async () => '0.1.0' }),
    strongVerifiers: { codex: async () => { strongCalled = true; return { verdict: VERDICTS.PASS }; } }
  });

  assert.equal((await verify('codex', '0.154.0')).verdict, VERDICTS.FAIL);
  assert.equal(strongCalled, false);
});

test('强判据可以把 pass 否决掉', async () => {
  const verify = createUpgradeVerifier({
    ...identityDeps(),
    strongVerifiers: { codex: async () => ({ verdict: VERDICTS.FAIL, detail: 'app server refused config' }) }
  });

  const result = await verify('codex', '0.154.0');
  assert.equal(result.verdict, VERDICTS.FAIL);
});

test('强判据自身抛错降级为 inconclusive,不连累结论', async () => {
  const verify = createUpgradeVerifier({
    ...identityDeps(),
    strongVerifiers: { codex: async () => { throw new Error('boom'); } }
  });

  assert.equal((await verify('codex', '0.154.0')).verdict, VERDICTS.INCONCLUSIVE);
});

// ---- codex 强判据 ----

function fakeSpawn(script) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => script(child));
    return child;
  };
}

// 0.154 事故的原始签名，macOS 与 Windows 双端都复现过。
test('codex 强判据:配置被拒绝且进程退出 → fail', async () => {
  const result = await verifyCodexAppServerBoot({
    spawn: fakeSpawn((child) => {
      child.stderr.emit('data', 'Error: error loading default config after config error: model_providers.aih_server: provider name must not be empty\n');
      child.emit('close', 1);
    }),
    verifyTimeoutMs: 2000
  });

  assert.equal(result.verdict, VERDICTS.FAIL);
  assert.match(result.detail, /must not be empty/);
});

test('codex 强判据:起来并开始监听 → pass', async () => {
  const result = await verifyCodexAppServerBoot({
    spawn: fakeSpawn((child) => {
      child.stdout.emit('data', 'codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:9635\n');
    }),
    verifyTimeoutMs: 2000
  });

  assert.equal(result.verdict, VERDICTS.PASS);
});

// 退出但没有配置类签名 → 说不清,不能据此回滚。
test('codex 强判据:退出但无可辨识签名 → inconclusive', async () => {
  const result = await verifyCodexAppServerBoot({
    spawn: fakeSpawn((child) => {
      child.stderr.emit('data', 'something unrelated\n');
      child.emit('close', 1);
    }),
    verifyTimeoutMs: 2000
  });

  assert.equal(result.verdict, VERDICTS.INCONCLUSIVE);
});

test('codex 强判据:spawn 失败 → inconclusive', async () => {
  const result = await verifyCodexAppServerBoot({
    spawn: () => { throw new Error('ENOENT'); },
    verifyTimeoutMs: 2000
  });

  assert.equal(result.verdict, VERDICTS.INCONCLUSIVE);
  assert.match(result.detail, /spawn_failed/);
});

// ---- 善后动作 ----

test('plan 声明的善后动作会被收集并去重', () => {
  const actions = collectPostInstallActions([
    { postInstall: ['reinstall_codex_cli_hook'] },
    { postInstall: ['reinstall_codex_cli_hook'] },
    {}
  ]);
  assert.deepEqual(actions, [POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK]);
});

test('hook 重装成功/失败都被如实汇报', async () => {
  const ok = await runPostInstallActions([POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK], {
    reinstallCodexCliHook: async () => ({ ok: true })
  });
  assert.equal(ok.ok, true);

  const failed = await runPostInstallActions([POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK], {
    reinstallCodexCliHook: async () => ({ ok: false, error: 'permission denied' })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failedAction, POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK);

  const threw = await runPostInstallActions([POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK], {
    reinstallCodexCliHook: async () => { throw new Error('boom'); }
  });
  assert.equal(threw.ok, false);
});

test('未注入 hook 实现时按跳过处理,不判失败', async () => {
  const result = await runPostInstallActions([POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK], {});
  assert.equal(result.ok, true);
  assert.equal(result.performed[0].skipped, true);
});
