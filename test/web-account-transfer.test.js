const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCodexAuthPayload,
  extractCodexMetadata,
  parseManualImportText,
  inferImportProvider
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
  assert.equal(meta.chatgptAccountId, 'acc_123');
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

test('inferImportProvider recognizes flat codex oauth payload', () => {
  assert.equal(inferImportProvider({
    refresh_token: 'rt_x',
    chatgpt_account_id: 'acc_x',
    plan_type: 'team'
  }), 'codex');
});
