const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refreshClaudeAccessToken } = require('../lib/server/claude-token-refresh');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-'));
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-old',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresAt: Date.now() - 60_000
      }
    })
  );
  return dir;
}

test('claude refresh posts to platform.claude.com with client_id + scope', async () => {
  const configDir = makeSandbox();
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'sk-ant-oat01-new',
        refresh_token: 'sk-ant-ort01-new',
        expires_in: 3600
      })
    };
  };

  const result = await refreshClaudeAccessToken(
    { id: '4', provider: 'claude', configDir, refreshToken: 'sk-ant-ort01-refresh', tokenExpiresAt: Date.now() - 60_000 },
    { force: true },
    { fetchWithTimeout: mockFetch }
  );

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(calls[0].body.grant_type, 'refresh_token');
  assert.equal(calls[0].body.refresh_token, 'sk-ant-ort01-refresh');
  assert.equal(calls[0].body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.ok(String(calls[0].body.scope).includes('user:inference'));

  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
  assert.equal(persisted.claudeAiOauth.accessToken, 'sk-ant-oat01-new');
});
