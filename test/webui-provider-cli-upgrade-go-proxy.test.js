'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleProviderCliUpgradeRoutes } = require('../lib/server/webui-provider-cli-upgrade-routes');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upgrade-'));
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run', 'provider-cli-upgrade.json'), JSON.stringify({ schemaVersion: 1, providers: {} }));
  return dir;
}

function makeCtx(options = {}) {
  let captured;
  const goHost = options.goHost === null ? undefined : {
    getProviderCliUpgrade: async () => options.result
  };
  return {
    get captured() { return captured; },
    ctx: {
      method: 'GET',
      pathname: '/v0/webui/provider-cli-upgrade',
      fs,
      aiHomeDir: setup(),
      deps: goHost ? { goCoreSync: goHost } : {},
      providerCliUpgradeScheduler: options.scheduler,
      res: {},
      writeJson: (_res, status, payload) => { captured = { status, payload }; }
    }
  };
}

test('provider-cli-upgrade GET：Go 行合并 Node lastTick 与 scheduler', async () => {
  const data = {
    ok: true,
    scheduler: null,
    global: { enabled: true, disabledReason: '' },
    providers: [{ provider: 'codex', state: 'ok', history: [] }]
  };
  const scheduler = {
    getState: () => ({
      running: true, cycling: false, enabled: true, providers: ['codex'],
      lastResult: { providers: { codex: { state: 'defer', reason: 'soak' } } }
    })
  };
  const state = makeCtx({ result: { ok: true, status: 200, data }, scheduler });
  await handleProviderCliUpgradeRoutes(state.ctx);
  assert.equal(state.captured.status, 200);
  const row = state.captured.payload.providers[0];
  assert.equal(row.lastTickState, 'defer');
  assert.equal(row.lastTickReason, 'soak');
  assert.equal(state.captured.payload.scheduler.running, true);
});

test('provider-cli-upgrade GET：缺少 Go 宿主时 503', async () => {
  const state = makeCtx({ goHost: null });
  await handleProviderCliUpgradeRoutes(state.ctx);
  assert.equal(state.captured.status, 503);
  assert.equal(state.captured.payload.error, 'go_core_unavailable');
});
