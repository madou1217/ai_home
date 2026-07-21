const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchAgyCodeAssistQuotaSnapshot,
  parseAgyCodeAssistQuotaSnapshot
} = require('../lib/server/code-assist-quota');

function assertMinimalQuotaHeaders(headers) {
  assert.deepEqual(Object.keys(headers).sort(), [
    'authorization',
    'content-type',
    'user-agent'
  ]);
  assert.equal(headers.authorization, 'Bearer token');
  assert.equal(headers['content-type'], 'application/json');
  assert.match(headers['user-agent'], /^Antigravity\/\d+\.\d+\.\d+ /);
}

function fakeJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('parseAgyCodeAssistQuotaSnapshot keeps only real quota-bearing provider model ids', () => {
  const snapshot = parseAgyCodeAssistQuotaSnapshot({
    models: {
      'claude-sonnet-4-6': {
        displayName: 'Claude Sonnet',
        supportsThinking: true,
        maxTokens: 200000,
        quotaInfo: {
          remainingFraction: 0.42,
          resetTime: new Date(Date.now() + 3600000).toISOString()
        }
      },
      MODEL_INTERNAL_ALPHA: {
        quotaInfo: {
          remainingFraction: 0.9,
          resetTime: new Date(Date.now() + 3600000).toISOString()
        }
      },
      chat_20706: {
        quotaInfo: {
          remainingFraction: 0.9,
          resetTime: new Date(Date.now() + 3600000).toISOString()
        }
      },
      'models/proactive-observer': {
        quotaInfo: {
          remainingFraction: 0.9,
          resetTime: new Date(Date.now() + 3600000).toISOString()
        }
      },
      'gemini-3.1-pro-preview': {
        displayName: 'Gemini Pro',
        quotaInfo: {}
      },
      tab_flash_lite_preview: {
        quotaInfo: {
          remainingFraction: 0.9
        },
        maxTokens: 16384,
        maxOutputTokens: 4096
      }
    },
    deprecatedModelIds: {
      'claude-old': { newModelId: 'claude-sonnet-4-6' },
      MODEL_LEGACY: { newModelId: 'claude-sonnet-4-6' }
    }
  }, {
    schemaVersion: 2,
    source: 'agy_fetch_available_models',
    capturedAt: 1234,
    account: {
      email: 'agy@example.com',
      subscriptionTier: 'Google AI Pro',
      project: 'projects/p1'
    }
  });

  assert.equal(snapshot.kind, 'agy_code_assist_quota');
  assert.deepEqual(snapshot.models.map((model) => model.model), ['claude-sonnet-4-6']);
  assert.equal(snapshot.models[0].remainingPct, 42);
  assert.equal(snapshot.models[0].displayName, 'Claude Sonnet');
  assert.equal(snapshot.models[0].supportsThinking, true);
  assert.equal(snapshot.models[0].maxTokens, 200000);
  assert.deepEqual(snapshot.modelForwardingRules, {
    'claude-old': 'claude-sonnet-4-6'
  });
  assert.equal(snapshot.account.email, 'agy@example.com');
  assert.equal(snapshot.account.planType, 'pro');
  assert.equal(snapshot.account.subscriptionTier, 'Google AI Pro');
  assert.equal(snapshot.account.project, 'projects/p1');
});

test('parseAgyCodeAssistQuotaSnapshot normalizes agy subscription tiers into plan types', () => {
  const payload = {
    models: {
      'gemini-3.5-flash-high': {
        quotaInfo: {
          remainingFraction: 1,
          resetTime: new Date(Date.now() + 3600000).toISOString()
        }
      }
    }
  };

  assert.equal(parseAgyCodeAssistQuotaSnapshot(payload, {
    account: { subscriptionTier: 'Antigravity Starter Quota' }
  }).account.planType, 'free');
  assert.equal(parseAgyCodeAssistQuotaSnapshot(payload, {
    account: { subscriptionTier: 'Google AI Pro' }
  }).account.planType, 'pro');
  assert.equal(parseAgyCodeAssistQuotaSnapshot(payload, {
    account: { subscriptionTier: 'Google AI Ultra' }
  }).account.planType, 'ultra');
});

test('fetchAgyCodeAssistQuotaSnapshot uses minimal quota headers and retries without project after 403', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body || '{}')
    });
    if (String(url).includes(':loadCodeAssist')) {
      return fakeJsonResponse(200, {
        cloudaicompanionProject: 'projects/agy-quota',
        paidTier: { name: 'Google AI Pro' }
      });
    }
    if (calls.filter((call) => call.url.includes(':fetchAvailableModels')).length === 1) {
      return fakeJsonResponse(403, { error: { message: 'project denied' } });
    }
    return fakeJsonResponse(200, {
      models: {
        'claude-sonnet-4-6': {
          quotaInfo: {
            remainingFraction: 0.75,
            resetTime: new Date(Date.now() + 7200000).toISOString()
          }
        }
      }
    });
  };

  const snapshot = await fetchAgyCodeAssistQuotaSnapshot({
    fetchImpl,
    agyQuotaBaseUrls: ['https://daily-cloudcode-pa.googleapis.com/v1internal'],
    schemaVersion: 2,
    source: 'agy_fetch_available_models'
  }, {
    provider: 'agy',
    accessToken: 'token',
    email: 'agy@example.com'
  });

  const loadCall = calls.find((call) => call.url.includes(':loadCodeAssist'));
  assertMinimalQuotaHeaders(loadCall.headers);
  assert.deepEqual(loadCall.body, {
    metadata: {
      ideType: 'ANTIGRAVITY'
    }
  });

  const modelCalls = calls.filter((call) => call.url.includes(':fetchAvailableModels'));
  assert.equal(modelCalls.length, 2);
  modelCalls.forEach((call) => assertMinimalQuotaHeaders(call.headers));
  assert.deepEqual(modelCalls[0].body, { project: 'projects/agy-quota' });
  assert.deepEqual(modelCalls[1].body, {});
  assert.equal(snapshot.account.project, 'projects/agy-quota');
  assert.equal(snapshot.account.planType, 'pro');
  assert.equal(snapshot.account.subscriptionTier, 'Google AI Pro');
  assert.equal(snapshot.models[0].model, 'claude-sonnet-4-6');
  assert.equal(snapshot.models[0].remainingPct, 75);
});

test('fetchAgyCodeAssistQuotaSnapshot falls back to the next endpoint on transient failure', async () => {
  const modelUrls = [];
  const fetchImpl = async (url) => {
    if (String(url).includes(':loadCodeAssist')) {
      return fakeJsonResponse(200, {
        cloudaicompanionProject: 'projects/cached',
        currentTier: { name: 'Default' }
      });
    }
    modelUrls.push(url);
    if (modelUrls.length === 1) {
      return fakeJsonResponse(500, { error: { message: 'temporary' } });
    }
    return fakeJsonResponse(200, {
      models: {
        'gemini-3.5-flash-high': {
          quotaInfo: {
            remainingFraction: 0.6,
            resetTime: new Date(Date.now() + 3600000).toISOString()
          }
        }
      }
    });
  };

  const snapshot = await fetchAgyCodeAssistQuotaSnapshot({
    fetchImpl,
    agyQuotaBaseUrls: [
      'https://one.example.com/v1internal',
      'https://two.example.com/v1internal'
    ],
    schemaVersion: 2,
    source: 'agy_fetch_available_models'
  }, {
    provider: 'agy',
    accessToken: 'token'
  });

  assert.equal(modelUrls.length, 2);
  assert.equal(modelUrls[0], 'https://one.example.com/v1internal:fetchAvailableModels');
  assert.equal(modelUrls[1], 'https://two.example.com/v1internal:fetchAvailableModels');
  assert.equal(snapshot.account.planType, 'free');
  assert.equal(snapshot.models[0].model, 'gemini-3.5-flash-high');
  assert.equal(snapshot.models[0].remainingPct, 60);
});
