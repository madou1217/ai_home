'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RESULT_KEYS,
  buildPlan,
  classifyHttpFailure,
  computePlanDigest,
  loadClientKey,
  loadStateFromDb,
  parseArgs,
  runHarness,
  validateBaseUrl,
} = require('../scripts/gateway-account-auth-smoke');

const PROVIDER_COUNTS = Object.freeze({
  agy: 7,
  claude: 1,
  codex: 3,
  grok: 2,
  kimi: 1,
  opencode: 1,
});

function accountRef(index) {
  return `acct_${String(index).padStart(20, '0')}`;
}

function makeState() {
  const accounts = [];
  const modelsByAccount = {};
  let index = 1;

  for (const [provider, count] of Object.entries(PROVIDER_COUNTS)) {
    for (let providerIndex = 0; providerIndex < count; providerIndex += 1) {
      const ref = accountRef(index);
      index += 1;
      accounts.push({
        provider,
        accountRef: ref,
        authMode: provider === 'opencode' ? 'opencode-auth' : 'oauth',
        status: 'up',
        configured: 1,
        apiKeyMode: 0,
      });
      modelsByAccount[ref] = [modelForProvider(provider)];
    }
  }

  return { accounts, modelsByAccount };
}

function modelForProvider(provider) {
  return {
    agy: 'gemini-2.5-flash',
    claude: 'claude-haiku-4-5-20251001',
    codex: 'gpt-5.4-mini',
    grok: 'grok-4.6',
    kimi: 'k3',
    opencode: 'opencode-go/deepseek-v4-flash',
  }[provider];
}

function fakeResponse({ status = 200, headers = {}, payload, text }) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  const serialized = text === undefined ? JSON.stringify(payload) : text;

  return {
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      },
    },
    async text() {
      return serialized;
    },
  };
}

function successPayload(provider, model) {
  if (provider === 'agy') {
    return {
      modelVersion: model,
      candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
    };
  }
  if (provider === 'claude') {
    return {
      type: 'message',
      model,
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 4, output_tokens: 1 },
    };
  }
  if (provider === 'codex') {
    return {
      object: 'response',
      status: 'completed',
      model,
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    };
  }
  return {
    model,
    choices: [{ message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
}

function makeSuccessFetch({ expectedSecret, inspectRequest } = {}) {
  let active = 0;
  let maxActive = 0;
  const calls = [];

  const fetchImpl = async (url, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ url, options });
    await Promise.resolve();

    if (options.method === 'GET') {
      active -= 1;
      return fakeResponse({ payload: { object: 'list', data: [] } });
    }

    const provider = options.headers['x-provider'];
    const ref = options.headers['x-account-ref'];
    const request = JSON.parse(options.body);
    const model = provider === 'agy'
      ? url.match(/\/models\/([^:]+):generateContent$/)[1]
      : request.model;

    if (expectedSecret) {
      assert.equal(options.headers.authorization, `Bearer ${expectedSecret}`);
    }
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-provider'], provider);
    assert.equal(options.headers['x-account-ref'], ref);
    inspectRequest?.({ provider, ref, model, request, url, options });

    const responseHeaders = {
      'x-aih-request-id': `request-${calls.length}`,
      'x-aih-server-account-ref': ref,
    };
    if (provider === 'codex') {
      responseHeaders['x-aih-effective-model'] = model;
    }
    const response = fakeResponse({
      headers: responseHeaders,
      payload: successPayload(provider, model),
    });
    active -= 1;
    return response;
  };

  return { fetchImpl, calls, getMaxActive: () => maxActive };
}

function assertResultWhitelist(result) {
  assert.deepEqual(Object.keys(result).sort(), [...RESULT_KEYS].sort());
  assert.deepEqual(
    Object.keys(result.usage).sort(),
    ['inputTokens', 'outputTokens', 'totalTokens'],
  );
}

async function executeSingle({ provider = 'kimi', fetchImpl, key = 'smoke-client-secret' } = {}) {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === provider);
  const state = {
    accounts: [account],
    modelsByAccount: { [account.accountRef]: source.modelsByAccount[account.accountRef] },
  };
  const plan = buildPlan(state);
  const requestFetch = async (url, options) => {
    if (options.method === 'GET') {
      return fakeResponse({ payload: { object: 'list', data: [] } });
    }
    return fetchImpl(url, options);
  };
  return runHarness({
    mode: 'execute',
    confirmedPlan: computePlanDigest(plan),
    baseUrl: 'http://127.0.0.1:9527',
    inventoryLoader: async () => state,
    keyLoader: async () => key,
    fetchImpl: requestFetch,
    timeoutSignalFactory: () => ({ mockSignal: true }),
    now: (() => {
      let value = 100;
      return () => {
        value += 2;
        return value;
      };
    })(),
  });
}

test('buildPlan dynamically produces 14 OAuth probes and one OpenCode auth probe', () => {
  const state = makeState();
  const plan = buildPlan(state);

  assert.equal(plan.length, 15);
  assert.equal(plan.filter((item) => item.authKind === 'oauth').length, 14);
  assert.equal(plan.filter((item) => item.authKind === 'opencode-auth').length, 1);
  assert.match(computePlanDigest(plan), /^[a-f0-9]{64}$/);
  assert.equal(computePlanDigest(plan), computePlanDigest(buildPlan(makeState())));
  assert.ok(plan.every((item) => !Object.hasOwn(item, 'prompt')));
  assert.ok(plan.every((item) => !Object.hasOwn(item, 'body')));
});

test('buildPlan supports an explicit accountRef subset and rejects unknown or disabled refs', () => {
  const state = makeState();
  const selected = [state.accounts[0].accountRef, state.accounts.at(-1).accountRef];
  const plan = buildPlan(state, { accountRefs: selected });

  assert.deepEqual(new Set(plan.map((item) => item.accountRef)), new Set(selected));
  assert.throws(
    () => buildPlan(state, { accountRefs: [accountRef(999)] }),
    (error) => error.code === 'unknown_account_ref',
  );

  const disabled = structuredClone(state);
  disabled.accounts[0].status = 'disabled';
  assert.throws(
    () => buildPlan(disabled, { accountRefs: [disabled.accounts[0].accountRef] }),
    (error) => error.code === 'unknown_account_ref',
  );

  const apiCredential = structuredClone(state);
  apiCredential.accounts[0].authMode = 'auth-token';
  assert.throws(
    () => buildPlan(apiCredential, { accountRefs: [apiCredential.accounts[0].accountRef] }),
    (error) => error.code === 'unknown_account_ref',
  );
});

test('dry-run never loads a client key and never calls fetch', async () => {
  let keyLoads = 0;
  let fetches = 0;
  const report = await runHarness({
    mode: 'dry-run',
    accountRefs: [makeState().accounts[0].accountRef],
    inventoryLoader: async () => makeState(),
    keyLoader: async () => {
      keyLoads += 1;
      return 'must-not-load';
    },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('must not fetch');
    },
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.plan.length, 1);
  assert.equal(keyLoads, 0);
  assert.equal(fetches, 0);
  assert.deepEqual(Object.keys(report).sort(), ['mode', 'plan', 'planDigest', 'summary']);
});

test('execute fails closed on a missing or stale confirmed plan before loading key or fetching', async () => {
  for (const confirmedPlan of [undefined, '0'.repeat(64)]) {
    let keyLoads = 0;
    let fetches = 0;
    await assert.rejects(
      runHarness({
        mode: 'execute',
        confirmedPlan,
        inventoryLoader: async () => makeState(),
        keyLoader: async () => {
          keyLoads += 1;
          return 'must-not-load';
        },
        fetchImpl: async () => {
          fetches += 1;
        },
      }),
      (error) => error.code === (confirmedPlan ? 'confirmed_plan_mismatch' : 'confirmed_plan_required'),
    );
    assert.equal(keyLoads, 0);
    assert.equal(fetches, 0);
  }
});

test('execute performs a gateway preflight and stops before inference on client-key 401', async () => {
  const source = makeState();
  const plan = buildPlan(source, { accountRefs: [source.accounts[0].accountRef] });
  let inferenceCalls = 0;
  await assert.rejects(
    runHarness({
      mode: 'execute',
      accountRefs: [source.accounts[0].accountRef],
      confirmedPlan: computePlanDigest(plan),
      inventoryLoader: async () => source,
      keyLoader: async () => 'safe-key',
      fetchImpl: async (_url, options) => {
        if (options.method === 'GET') {
          return fakeResponse({ status: 401, payload: { error: 'unauthorized_client' } });
        }
        inferenceCalls += 1;
        throw new Error('inference_must_not_run');
      },
      timeoutSignalFactory: () => ({ mockSignal: true }),
    }),
    (error) => error.code === 'client_key_source_mismatch',
  );
  assert.equal(inferenceCalls, 0);
});

test('execute is serial, pins provider/account headers, and emits only whitelisted evidence', async () => {
  const state = makeState();
  const secret = 'client-key-never-in-report';
  const { fetchImpl, calls, getMaxActive } = makeSuccessFetch({ expectedSecret: secret });
  const plan = buildPlan(state);
  const report = await runHarness({
    mode: 'execute',
    confirmedPlan: computePlanDigest(plan),
    baseUrl: 'http://localhost:9527',
    inventoryLoader: async () => state,
    keyLoader: async () => secret,
    fetchImpl,
    timeoutSignalFactory: () => ({ mockSignal: true }),
  });

  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 15);
  assert.equal(getMaxActive(), 1);
  assert.equal(report.summary.usable, 15);
  assert.equal(report.summary.failed, 0);
  assert.ok(report.results.every((result) => result.outcome === 'usable'));
  report.results.forEach(assertResultWhitelist);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(secret), false);
  for (const forbiddenName of ['authorization', 'headers', 'prompt', 'body', 'content', 'detail', 'raw', 'email', 'stack', 'message']) {
    assert.equal(serialized.includes(`\"${forbiddenName}\"`), false, forbiddenName);
  }
});

test('provider probes use bounded minimal payloads and strict effective models', async () => {
  const state = makeState();
  const onePerProvider = Object.keys(PROVIDER_COUNTS).map(
    (provider) => state.accounts.find((account) => account.provider === provider).accountRef,
  );
  const plan = buildPlan(state, { accountRefs: onePerProvider });
  const seen = new Map();
  const { fetchImpl } = makeSuccessFetch({
    inspectRequest({ provider, request, url }) {
      seen.set(provider, { request, url });
    },
  });

  const report = await runHarness({
    mode: 'execute',
    accountRefs: onePerProvider,
    confirmedPlan: computePlanDigest(plan),
    inventoryLoader: async () => state,
    keyLoader: async () => 'safe-key',
    fetchImpl,
    timeoutSignalFactory: () => ({ mockSignal: true }),
  });

  assert.equal(report.summary.usable, 6);
  assert.equal(seen.get('agy').request.generationConfig.maxOutputTokens, 8);
  assert.equal(seen.get('agy').request.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.match(seen.get('agy').url, /:generateContent$/);
  assert.equal(seen.get('claude').request.max_tokens, 8);
  assert.equal(seen.get('codex').request.max_output_tokens, undefined);
  assert.deepEqual(seen.get('codex').request.reasoning, { effort: 'low' });
  assert.ok(Array.isArray(seen.get('codex').request.input));
  assert.equal(seen.get('codex').request.input[0].role, 'user');
  assert.equal(seen.get('codex').request.store, false);
  for (const provider of ['grok', 'kimi', 'opencode']) {
    assert.equal(seen.get(provider).request.max_tokens, provider === 'kimi' ? 128 : 8);
    assert.equal(seen.get(provider).request.stream, false);
  }
});

test('AGY probe accepts the bridge response envelope and preserves its usage/model evidence', async () => {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === 'agy');
  const model = modelForProvider('agy');
  const report = await executeSingle({
    provider: 'agy',
    fetchImpl: async () => fakeResponse({
      headers: {
        'x-aih-request-id': 'request-agy-envelope',
        'x-aih-server-account-ref': account.accountRef,
      },
      payload: {
        response: successPayload('agy', model),
        metadata: {},
        traceId: 'trace-only',
      },
    }),
  });

  assert.equal(report.results[0].outcome, 'usable');
  assert.deepEqual(report.results[0].usage, {
    inputTokens: 4,
    outputTokens: 1,
    totalTokens: 5,
  });
  assert.equal(report.results[0].effectiveModel, model);
});

test('strictly detects account fallback, effective-model drift, invalid shape, and absent text', async (t) => {
  const cases = [
    {
      name: 'account fallback',
      mutate: ({ ref, model }) => fakeResponse({
        headers: {
          'x-aih-request-id': 'request-1',
          'x-aih-server-account-ref': accountRef(998),
        },
        payload: successPayload('kimi', model),
      }),
      outcome: 'routing_fallback_violation',
    },
    {
      name: 'effective model drift',
      mutate: ({ ref }) => fakeResponse({
        headers: { 'x-aih-request-id': 'request-1', 'x-aih-server-account-ref': ref },
        payload: successPayload('kimi', 'different-model'),
      }),
      outcome: 'effective_model_mismatch',
    },
    {
      name: 'invalid response shape',
      mutate: ({ ref, model }) => fakeResponse({
        headers: { 'x-aih-request-id': 'request-1', 'x-aih-server-account-ref': ref },
        payload: { model, choices: 'not-an-array' },
      }),
      outcome: 'invalid_response_shape',
    },
    {
      name: 'missing assistant text',
      mutate: ({ ref, model }) => fakeResponse({
        headers: { 'x-aih-request-id': 'request-1', 'x-aih-server-account-ref': ref },
        payload: { model, choices: [{ message: { content: '' } }] },
      }),
      outcome: 'missing_assistant_content',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const source = makeState();
      const account = source.accounts.find((candidate) => candidate.provider === 'kimi');
      const model = modelForProvider('kimi');
      const report = await executeSingle({
        fetchImpl: async () => testCase.mutate({ ref: account.accountRef, model }),
      });
      assert.equal(report.results[0].outcome, testCase.outcome);
      assert.equal(report.summary.failed, 1);
      assertResultWhitelist(report.results[0]);
    });
  }
});

test('Codex requires exact x-aih-effective-model evidence even when body model matches', async () => {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === 'codex');
  const model = modelForProvider('codex');
  const report = await executeSingle({
    provider: 'codex',
    fetchImpl: async () => fakeResponse({
      headers: {
        'x-aih-request-id': 'request-1',
        'x-aih-server-account-ref': account.accountRef,
      },
      payload: successPayload('codex', model),
    }),
  });

  assert.equal(report.results[0].outcome, 'missing_effective_model');
});

test('Codex also rejects a mismatched body model when the effective-model header matches', async () => {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === 'codex');
  const model = modelForProvider('codex');
  const payload = successPayload('codex', model);
  payload.model = 'different-model';
  const report = await executeSingle({
    provider: 'codex',
    fetchImpl: async () => fakeResponse({
      headers: {
        'x-aih-request-id': 'request-1',
        'x-aih-server-account-ref': account.accountRef,
        'x-aih-effective-model': model,
      },
      payload,
    }),
  });

  assert.equal(report.results[0].outcome, 'effective_model_mismatch');
});

test('Codex accepts a dated effective-model version for the requested model alias', async () => {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === 'codex');
  const requestedModel = modelForProvider('codex');
  const effectiveModel = `${requestedModel}-2026-03-17`;
  const payload = successPayload('codex', effectiveModel);
  const report = await executeSingle({
    provider: 'codex',
    fetchImpl: async () => fakeResponse({
      headers: {
        'x-aih-request-id': 'request-versioned-model',
        'x-aih-server-account-ref': account.accountRef,
        'x-aih-effective-model': effectiveModel,
      },
      payload,
    }),
  });

  assert.equal(report.results[0].outcome, 'usable');
  assert.equal(report.results[0].effectiveModel, requestedModel);
});

test('HTTP failure classification separates credential, quota, policy, and rate-limit causes', () => {
  assert.equal(classifyHttpFailure(401, 'auth_invalid_reauth_required', []), 'credential_invalid');
  assert.equal(classifyHttpFailure(401, 'unauthorized_client', []), 'client_key_source_mismatch');
  assert.equal(classifyHttpFailure(503, 'no_available_account', ['blocked_by_quota']), 'quota_blocked');
  assert.equal(classifyHttpFailure(503, 'no_available_account', ['blocked_by_policy']), 'policy_blocked');
  assert.equal(classifyHttpFailure(503, 'no_available_account', ['credential_invalid']), 'credential_invalid');
  assert.equal(classifyHttpFailure(503, 'no_available_account', ['rate_limited']), 'rate_limited');
  assert.equal(classifyHttpFailure(402, null, []), 'quota_blocked');
  assert.equal(classifyHttpFailure(429, 'upstream_rate_limited', []), 'rate_limited');
  assert.equal(classifyHttpFailure(404, 'model_not_found', []), 'catalog_or_model_drift');
});

test('HTTP errors retain only safe codes and never leak detail, tokens, email, prompt, or raw body', async () => {
  const source = makeState();
  const account = source.accounts.find((candidate) => candidate.provider === 'kimi');
  const secretFragments = [
    'Bearer secret-token',
    'person@example.test',
    'Reply exactly OK.',
  ];
  const report = await executeSingle({
    fetchImpl: async () => fakeResponse({
      status: 503,
      headers: {
        'x-aih-request-id': 'request-failed',
        'retry-after': '12',
      },
      payload: {
        error: 'no_available_account',
        detail: secretFragments.join(' '),
        availability: {
          reasons: [{
            reason: 'blocked_by_quota:provider_specific_secret_reason',
            sampleAccountRefs: [account.accountRef],
            detail: 'do not retain',
          }],
        },
      },
    }),
  });

  const result = report.results[0];
  assert.equal(result.outcome, 'quota_blocked');
  assert.equal(result.errorCode, 'no_available_account');
  assert.deepEqual(result.availabilityReasonCodes, ['blocked_by_quota']);
  assert.equal(result.selectedAccountRef, account.accountRef);
  assert.equal(result.accountRefMatched, true);
  assert.equal(result.retryAfterSeconds, 12);
  assertResultWhitelist(result);
  const serialized = JSON.stringify(report);
  for (const fragment of secretFragments) {
    assert.equal(serialized.includes(fragment), false);
  }
  assert.equal(serialized.includes('do not retain'), false);
});

test('response size and timeout failures are bounded and safely classified', async (t) => {
  await t.test('oversized response', async () => {
    const report = await executeSingle({
      fetchImpl: async () => fakeResponse({ text: 'x'.repeat((256 * 1024) + 1) }),
    });
    assert.equal(report.results[0].outcome, 'response_too_large');
  });

  await t.test('timeout', async () => {
    const report = await executeSingle({
      fetchImpl: async () => {
        const error = new Error('Bearer secret-token person@example.test');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    assert.equal(report.results[0].outcome, 'timeout');
    assert.equal(JSON.stringify(report).includes('secret-token'), false);
  });
});

test('loadStateFromDb uses a read-only DatabaseSync and SELECT-only app_state/app_kv reads', () => {
  const state = makeState();
  const calls = [];
  class FakeDatabaseSync {
    constructor(path, options) {
      calls.push({ type: 'open', path, options });
    }

    prepare(sql) {
      calls.push({ type: 'prepare', sql });
      assert.match(sql.trim(), /^SELECT\b/i);
      if (sql.includes('account_state')) {
        return {
          all: () => state.accounts.map((account) => ({
            provider: account.provider,
            account_ref: account.accountRef,
            auth_mode: account.authMode,
            status: account.status,
            configured: account.configured,
            api_key_mode: account.apiKeyMode,
          })),
        };
      }
      return {
        get: (key) => {
          assert.equal(key, 'cache:webui-models-snapshot.json');
          return {
            value: JSON.stringify({
              byAccount: Object.fromEntries(
                Object.entries(state.modelsByAccount).map(([ref, models]) => [
                  ref,
                  models.map((id) => ({ id })),
                ]),
              ),
            }),
          };
        },
      };
    }

    close() {
      calls.push({ type: 'close' });
    }
  }

  const loaded = loadStateFromDb({
    dbPath: '/mock/app-state.db',
    DatabaseSyncImpl: FakeDatabaseSync,
  });

  assert.deepEqual(loaded, state);
  assert.deepEqual(calls[0], {
    type: 'open',
    path: '/mock/app-state.db',
    options: { readOnly: true },
  });
  assert.equal(calls.at(-1).type, 'close');
});

test('client key loading prefers the dedicated env and otherwise reads config:server JSON read-only', () => {
  let opens = 0;
  class MustNotOpenDatabase {
    constructor() {
      opens += 1;
      throw new Error('must not open');
    }
  }
  assert.equal(loadClientKey({
    env: { AIH_ACCOUNT_SMOKE_CLIENT_KEY: 'env-client-key' },
    dbPath: '/mock/app-state.db',
    DatabaseSyncImpl: MustNotOpenDatabase,
  }), 'env-client-key');
  assert.equal(opens, 0);

  const aliases = [
    [{ apiKey: 'stored-api-key' }, 'stored-api-key'],
    [{ clientKey: 'stored-client-key' }, 'stored-client-key'],
    [{ api_key: 'stored-snake-key' }, 'stored-snake-key'],
    [{ client_key: 'stored-client-snake-key' }, 'stored-client-snake-key'],
  ];
  for (const [serverConfig, expected] of aliases) {
    const calls = [];
    class FakeDatabaseSync {
      constructor(path, options) {
        calls.push({ path, options });
      }

      prepare(sql) {
        assert.match(sql.trim(), /^SELECT\b/i);
        return {
          get(key) {
            assert.equal(key, 'config:server');
            return { value: JSON.stringify(serverConfig) };
          },
        };
      }

      close() {}
    }
    assert.equal(loadClientKey({
      env: {},
      dbPath: '/mock/app-state.db',
      DatabaseSyncImpl: FakeDatabaseSync,
    }), expected);
    assert.deepEqual(calls[0].options, { readOnly: true });
  }
});

test('CLI rejects argv keys, enforces loopback, and supports repeatable account refs', () => {
  const first = accountRef(1);
  const second = accountRef(2);
  assert.deepEqual(
    parseArgs(['--dry-run', '--account-ref', first, `--account-ref=${second}`, '--json']),
    {
      mode: 'dry-run',
      baseUrl: 'http://127.0.0.1:9527',
      confirmedPlan: undefined,
      accountRefs: [first, second],
      json: true,
      dbPath: undefined,
      timeoutMs: 30000,
      maxResponseBytes: 262144,
    },
  );
  for (const flag of ['--key', '--api-key', '--client-key']) {
    assert.throws(() => parseArgs([flag, 'secret']), (error) => error.code === 'argv_key_forbidden');
  }
  assert.throws(
    () => validateBaseUrl('https://gateway.example.test'),
    (error) => error.code === 'non_loopback_base_url',
  );
  assert.equal(validateBaseUrl('http://[::1]:9527/'), 'http://[::1]:9527');
});
