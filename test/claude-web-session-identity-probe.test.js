const test = require('node:test');
const assert = require('node:assert/strict');
const {
  probeClaudeWebSessionIdentity
} = require('../lib/cli/services/ai-cli/claude-web-session-identity-probe');

test('Claude web identity probe returns only bootstrap account identity', async () => {
  const calls = [];
  const result = await probeClaudeWebSessionIdentity({
    sessionKey: 'sk-ant-sid-secret-session',
    lastActiveOrg: '11111111-2222-4333-8444-555555555555'
  }, {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            account: {
              uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              email_address: 'target@example.com',
              memberships: [
                {
                  organization: {
                    uuid: '11111111-2222-4333-8444-555555555555'
                  }
                }
              ]
            }
          };
        }
      };
    }
  });

  assert.deepEqual(result, {
    status: 'ok',
    accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    emailAddress: 'target@example.com',
    organizationUuids: ['11111111-2222-4333-8444-555555555555']
  });
  assert.equal(calls[0].url, 'https://claude.ai/api/bootstrap');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(
    calls[0].options.headers.Cookie,
    'sessionKey=sk-ant-sid-secret-session; lastActiveOrg=11111111-2222-4333-8444-555555555555'
  );
});

test('Claude web identity probe fails closed for rejected or malformed bootstrap responses', async () => {
  assert.deepEqual(await probeClaudeWebSessionIdentity({
    sessionKey: 'sk-ant-sid-secret-session',
    lastActiveOrg: '11111111-2222-4333-8444-555555555555'
  }, {
    fetch: async () => ({ ok: false, status: 401 })
  }), {
    status: 'rejected'
  });

  assert.deepEqual(await probeClaudeWebSessionIdentity({
    sessionKey: 'sk-ant-sid-secret-session',
    lastActiveOrg: '11111111-2222-4333-8444-555555555555'
  }, {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { account: { uuid: '', email_address: '' } };
      }
    })
  }), {
    status: 'unavailable'
  });
});
