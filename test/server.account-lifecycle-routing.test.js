'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { chooseServerAccount } = require('../lib/server/account-selector');
const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');

const MODEL = 'gpt-6-astra';

function createScenario(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-lifecycle-routing-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const serverIndex = createAccountStateIndex({ fs, aiHomeDir });
  const cliIndex = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => {
    serverIndex.close();
    cliIndex.close();
  });

  const staleRegistration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'oauth:bug8-stale@example.com',
    cliAccountId: '1'
  });
  const healthyRegistration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'oauth:bug8-healthy@example.com',
    cliAccountId: '2'
  });
  const staleRef = staleRegistration.accountRef;
  const healthyRef = healthyRegistration.accountRef;

  [staleRef, healthyRef].forEach((accountRef) => {
    cliIndex.upsertAccountState(accountRef, 'codex', {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-personal',
      remainingPct: 80
    });
  });

  const accounts = [
    { accountRef: staleRef, provider: 'codex', authType: 'oauth-personal', accessToken: 'stale-oauth-token', remainingPct: 80 },
    { accountRef: healthyRef, provider: 'codex', authType: 'oauth-personal', accessToken: 'healthy-oauth-token', remainingPct: 80 }
  ];

  return { serverIndex, cliIndex, staleRef, healthyRef, accounts };
}

function select(scenario, options = {}, accounts = scenario.accounts) {
  const state = options.state || { strategy: 'round-robin', cursor: 0 };
  return chooseServerAccount(accounts, state, 'codex', {
    provider: 'codex',
    model: MODEL,
    accountStateIndex: scenario.serverIndex,
    ...options
  });
}

function disableFromCli(scenario, action) {
  if (action === 'delete') {
    assert.equal(scenario.cliIndex.deleteAccountState(scenario.staleRef), true);
  } else {
    assert.equal(scenario.cliIndex.setStatus(scenario.staleRef, 'down'), true);
  }
}

test('account lifecycle routing rejects stale server snapshots after CLI down/delete', async (t) => {
  const modes = [
    ['ordinary', {}],
    ['preferred default', { preferredAccountRef: 'stale' }],
    ['sticky session', { sessionKey: 'bug8-sticky' }],
    ['encrypted affinity', { sessionKey: 'test-session', preserveEncryptedReasoningAffinity: true }],
    ['model cooled last resort', { allowModelCooled: true }],
    ['encrypted affinity with model cooled last resort', {
      sessionKey: 'test-session',
      preserveEncryptedReasoningAffinity: true,
      allowModelCooled: true
    }]
  ];

  for (const action of ['down', 'delete']) {
    for (const [name, options] of modes) {
      await t.test(`${action}: ${name}`, () => {
        const scenario = createScenario(t);
        const resolvedOptions = {
          ...options,
          preferredAccountRef: options.preferredAccountRef === 'stale'
            ? scenario.staleRef
            : options.preferredAccountRef
        };
        if (resolvedOptions.allowModelCooled) {
          scenario.serverIndex.upsertRuntimeState(scenario.staleRef, 'codex', {
            modelCooldowns: { [MODEL]: Date.now() + 60_000 }
          }, {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            authMode: 'oauth-personal',
            remainingPct: 80
          });
        }
        const initial = select(scenario, resolvedOptions);
        assert.equal(initial.accountRef, scenario.staleRef);
        assert.equal(scenario.serverIndex.getAccountState(scenario.staleRef).status, 'up');

        if (resolvedOptions.preserveEncryptedReasoningAffinity && !resolvedOptions.allowModelCooled) {
          scenario.serverIndex.upsertRuntimeState(scenario.staleRef, 'codex', {
            modelCooldowns: { [MODEL]: Date.now() + 60_000 }
          }, {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            authMode: 'oauth-personal',
            remainingPct: 80
          });
        }

        disableFromCli(scenario, action);

        const next = select(scenario, resolvedOptions);
        assert.equal(next && next.accountRef, scenario.healthyRef);
        assert.equal(next.authType, 'oauth-personal');
      });
    }
  }
});

test('account lifecycle routing returns null when the only cached account is down or deleted', async (t) => {
  for (const action of ['down', 'delete']) {
    await t.test(action, () => {
      const scenario = createScenario(t);
      const onlyAccount = [scenario.accounts[0]];
      assert.equal(select(scenario, {}, onlyAccount).accountRef, scenario.staleRef);
      disableFromCli(scenario, action);
      assert.equal(select(scenario, {
        sessionKey: 'bug8-only-account',
        preserveEncryptedReasoningAffinity: true,
        allowModelCooled: true
      }, onlyAccount), null);
    });
  }
});

test('account lifecycle routing sends no request to the disabled upstream endpoint', async (t) => {
  const scenario = createScenario(t);
  const hits = { stale: 0, healthy: 0 };
  const upstream = http.createServer((req, res) => {
    if (req.url === '/stale') hits.stale += 1;
    if (req.url === '/healthy') hits.healthy += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  t.after(() => upstream.close());
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const accounts = scenario.accounts.map((account, index) => ({
    ...account,
    upstreamPath: index === 0 ? '/stale' : '/healthy'
  }));
  const state = { strategy: 'round-robin', cursor: 0 };
  const run = () => runWithAccountAttempts({
    pool: accounts,
    maxAttempts: 1,
    selectionState: state,
    cursorState: state,
    cursorKey: 'codex',
    provider: 'codex',
    model: MODEL,
    chooseServerAccount: (pool, selection, cursorKey, options) => chooseServerAccount(pool, selection, cursorKey, {
      ...options,
      accountStateIndex: scenario.serverIndex
    }),
    onAttempt: async (account) => {
      await fetch(`${baseUrl}${account.upstreamPath}`);
      return { action: 'return', value: { ok: true } };
    }
  });

  assert.equal((await run()).kind, 'returned');
  assert.deepEqual(hits, { stale: 1, healthy: 0 });
  disableFromCli(scenario, 'down');
  assert.equal((await run()).kind, 'returned');
  assert.deepEqual(hits, { stale: 1, healthy: 1 });
});
