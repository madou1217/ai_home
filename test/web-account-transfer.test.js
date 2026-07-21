const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCodexAuthPayload,
  extractCodexMetadata,
  parseManualImportText,
  inferImportProvider,
  buildCodexAuthIdentityKey,
  buildOAuthIdentity,
  buildApiKeyIdentity
} = require('../lib/server/web-account-transfer');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('normalizeCodexAuthPayload accepts flat codex oauth json', () => {
  const payload = normalizeCodexAuthPayload({
    access_token: 'at_x',
    refresh_token: 'rt_x',
    id_token: 'id_x',
    chatgpt_account_id: 'acc_x'
  });

  assert.deepEqual(payload, {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: 'at_x',
      refresh_token: 'rt_x',
      id_token: 'id_x',
      account_id: 'acc_x'
    },
    last_refresh: payload.last_refresh
  });
});

test('extractCodexMetadata reads plan/client/account/user fields from jwt payload', () => {
  const accessToken = makeJwt({
    client_id: 'app_test',
    exp: 1776600282,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'team',
      chatgpt_account_id: 'acc_123',
      chatgpt_user_id: 'user_chatgpt_123',
      user_id: 'user_123',
      organizations: [{ id: 'org_123', is_default: true }]
    },
    'https://api.openai.com/profile': {
      email: 'test@example.com'
    }
  });

  const meta = extractCodexMetadata({
    tokens: {
      access_token: accessToken,
      refresh_token: 'rt_x',
      id_token: ''
    }
  });

  assert.equal(meta.email, 'test@example.com');
  assert.equal(meta.planType, 'team');
  assert.equal(meta.clientId, 'app_test');
  assert.equal(meta.upstreamAccountId, 'acc_123');
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'chatgptAccountId'), false);
  assert.equal(meta.chatgptUserId, 'user_chatgpt_123');
  assert.equal(meta.userId, 'user_123');
  assert.equal(meta.organizationId, 'org_123');
  assert.equal(meta.expiresAt, 1776600282000);
});

test('parseManualImportText supports jsonl input', () => {
  const rows = parseManualImportText('{"provider":"codex","refresh_token":"rt_1"}\n{"provider":"gemini","access_token":"at_2"}');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[1].provider, 'gemini');
});

test('parseManualImportText expands web ui export bundles and arrays', () => {
  const rows = parseManualImportText(JSON.stringify({
    version: 2,
    accounts: [
      { provider: 'codex', auth: { tokens: { refresh_token: 'rt_1' } } },
      [
        { provider: 'gemini', auth: { access_token: 'at_2' } }
      ]
    ]
  }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[1].provider, 'gemini');
});

test('parseManualImportText normalizes Antigravity Manager account exports', () => {
  const modern = parseManualImportText(JSON.stringify({
    accounts: [
      { email: 'Agy@Example.com', refresh_token: 'rt_agy' }
    ]
  }));
  assert.equal(modern.length, 1);
  assert.equal(modern[0].provider, 'agy');
  assert.equal(modern[0].email, 'agy@example.com');
  assert.equal(modern[0].token.refresh_token, 'rt_agy');
  assert.equal(inferImportProvider(modern[0]), 'agy');

  const legacy = parseManualImportText(JSON.stringify([
    ['legacy@example.com', 'rt_legacy']
  ]));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].provider, 'agy');
  assert.equal(legacy[0].token.refresh_token, 'rt_legacy');
});

test('parseManualImportText normalizes Antigravity Manager plugin v3 exports', () => {
  const rows = parseManualImportText(JSON.stringify({
    version: 3,
    accounts: [
      {
        email: 'Plugin@Example.com',
        refreshToken: 'rt_plugin',
        projectId: 'project-x',
        addedAt: 1760000000000,
        lastUsed: 1760000000001,
        rateLimitResetTimes: {},
        enabled: true
      }
    ],
    activeIndex: 0,
    activeIndexByFamily: {
      claude: 0,
      gemini: 0
    }
  }));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'agy');
  assert.equal(rows[0].email, 'plugin@example.com');
  assert.equal(rows[0].token.refresh_token, 'rt_plugin');
  assert.equal(inferImportProvider(rows[0]), 'agy');
});

test('parseManualImportText normalizes sub2api account bundle records', () => {
  const rows = parseManualImportText(JSON.stringify({
    type: 'sub2api-data',
    version: 1,
    accounts: [
      {
        platform: 'openai',
        type: 'oauth',
        credentials: {
          email: 'codex@example.com',
          refresh_token: 'rt_codex',
          chatgpt_account_id: 'acct_codex'
        }
      },
      {
        platform: 'openai',
        type: 'api-key',
        credentials: {
          api_key: 'sk-sub2api',
          base_url: 'https://sub2api.example.com/v1/'
        }
      }
    ]
  }));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'codex');
  assert.equal(rows[0].refresh_token, 'rt_codex');
  assert.equal(rows[0].chatgpt_account_id, 'acct_codex');
  assert.equal(rows[1].provider, 'codex');
  assert.deepEqual(rows[1].config, {
    OPENAI_API_KEY: 'sk-sub2api',
    OPENAI_BASE_URL: 'https://sub2api.example.com/v1'
  });
});

test('parseManualImportText normalizes current sub2api exports without type header', () => {
  const rows = parseManualImportText(JSON.stringify({
    exported_at: '2026-06-08T00:00:00Z',
    proxies: [],
    accounts: [
      {
        name: 'claude key',
        platform: 'anthropic',
        type: 'apikey',
        credentials: {
          api_key: 'sk-ant',
          base_url: 'https://api.anthropic.com/'
        },
        concurrency: 0,
        priority: 0
      },
      {
        name: 'agy oauth',
        platform: 'antigravity',
        type: 'oauth',
        credentials: {
          email: 'AgySub@example.com',
          refresh_token: 'rt_agy_sub'
        },
        concurrency: 0,
        priority: 0
      }
    ]
  }));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'claude');
  assert.deepEqual(rows[0].config, {
    apiKey: 'sk-ant',
    baseUrl: 'https://api.anthropic.com'
  });
  assert.equal(rows[1].provider, 'agy');
  assert.equal(rows[1].email, 'agysub@example.com');
  assert.equal(rows[1].token.refresh_token, 'rt_agy_sub');
});

test('inferImportProvider recognizes flat codex oauth payload', () => {
  assert.equal(inferImportProvider({
    refresh_token: 'rt_x',
    chatgpt_account_id: 'acc_x',
    plan_type: 'team'
  }), 'codex');
});

test('inferImportProvider recognizes codex auth.json payload', () => {
  assert.equal(inferImportProvider({
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_x',
      account_id: 'acc_x'
    }
  }), 'codex');
});

test('buildOAuthIdentity only accepts provider email for oauth identity', () => {
  const accessToken = makeJwt({
    'https://api.openai.com/profile': {
      email: 'Identity@Example.com'
    }
  });
  assert.equal(buildCodexAuthIdentityKey({
    tokens: {
      access_token: accessToken,
      refresh_token: 'opaque-refresh-token'
    }
  }), 'oauth:codex:identity@example.com');

  assert.equal(buildCodexAuthIdentityKey({
    tokens: {
      access_token: accessToken,
      refresh_token: 'rt_secret'
    }
  }), 'oauth:codex:identity@example.com');

  assert.equal(buildOAuthIdentity('codex', {
    tokens: {
      refresh_token: 'rt_secret',
      account_id: 'acc_only'
    }
  }), '');
});

test('buildOAuthIdentity scopes identical email by provider', () => {
  assert.equal(buildOAuthIdentity('codex', { email: 'same@example.com' }), 'oauth:codex:same@example.com');
  assert.equal(buildOAuthIdentity('gemini', { email: 'same@example.com' }), 'oauth:gemini:same@example.com');
});

test('buildApiKeyIdentity uses provider normalized url and key', () => {
  assert.equal(buildApiKeyIdentity('codex', {
    config: {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: ' https://api.example.com/v1/// '
    }
  }), 'api_key:codex:https://api.example.com/v1:sk-test');

  assert.equal(buildApiKeyIdentity('codex', {
    config: {
      OPENAI_BASE_URL: 'https://api.example.com/v1'
    }
  }), '');
});

test('buildApiKeyIdentity prefers claude auth-token over anthropic api key when both are present', () => {
  assert.equal(buildApiKeyIdentity('claude', {
    config: {
      ANTHROPIC_API_KEY: 'sk-api-key',
      ANTHROPIC_AUTH_TOKEN: 'sk-auth-token',
      ANTHROPIC_BASE_URL: 'https://anyrouter.top/'
    }
  }), 'auth_token:claude:https://anyrouter.top:sk-auth-token');
});
