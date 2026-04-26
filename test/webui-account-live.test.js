const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refreshLiveAccountRecord } = require('../lib/server/webui-account-live');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

test('refreshLiveAccountRecord prefers trusted usage snapshot remaining over stale indexed/runtime remaining', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'codex', '5');
  const configDir = path.join(profileDir, '.codex');
  writeJson(path.join(configDir, 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_5',
      access_token: 'at_5',
      id_token: '',
      account_id: 'acc_5'
    }
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'free',
      email: 'code5@meadeo.com',
      accountId: 'acc_5',
      organizationId: ''
    },
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 10080,
        window: '7days',
        remainingPct: 94,
        resetIn: '166h',
        resetAtMs: Date.now() + 600000000
      }
    ]
  });

  const ctx = {
    state: {
      accounts: {
        codex: [
          {
            id: '5',
            provider: 'codex',
            email: 'code5@meadeo.com',
            remainingPct: 0,
            cooldownUntil: 0
          }
        ],
        gemini: [],
        claude: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider === 'codex' && accountId === '5') {
          return {
            configured: true,
            api_key_mode: false,
            remaining_pct: 0,
            display_name: 'code5@meadeo.com',
            updated_at: 123
          };
        }
        return null;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['5'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId), '.codex');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId));
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'code5@meadeo.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'codex', '5', {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.remainingPct, 94);
  assert.equal(record.quotaStatus, 'available');
  assert.equal(record.schedulableStatus, 'schedulable');
  assert.equal(record.usageSnapshot.entries[0].remainingPct, 94);
});
