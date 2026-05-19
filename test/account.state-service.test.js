const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountStateService } = require('../lib/account/state-service');

test('account state service writes operational status through one boundary and mirrors status file', () => {
  const calls = [];
  const files = new Map();
  const service = createAccountStateService({
    fs: {
      mkdirSync(dir) {
        calls.push({ op: 'mkdir', dir });
      },
      writeFileSync(file, content) {
        files.set(file, content);
      }
    },
    getProfileDir: () => '/tmp/aih/profiles/codex/1',
    accountStateIndex: {
      getAccountState() {
        return {
          account_id: '1',
          status: 'up',
          configured: true,
          api_key_mode: false,
          display_name: 'user@example.com'
        };
      },
      setStatus(provider, accountId, status) {
        calls.push({ op: 'setStatus', provider, accountId, status });
        return true;
      }
    }
  });

  assert.equal(service.setOperationalStatus('Codex', '1', 'down'), true);
  assert.deepEqual(calls.find((call) => call.op === 'setStatus'), {
    op: 'setStatus',
    provider: 'codex',
    accountId: '1',
    status: 'down'
  });
  assert.equal(files.get('/tmp/aih/profiles/codex/1/.aih_status'), 'down\n');
});

test('account state service requires evidence before clearing runtime block', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          account_id: '1',
          status: 'up',
          configured: true,
          api_key_mode: false,
          display_name: 'user@example.com'
        };
      },
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        writes.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock('codex', '1', { evidence: 'account_read_metadata' }), false);
  assert.equal(writes.length, 0);
  assert.equal(service.clearRuntimeBlock('codex', '1', { evidence: 'token_refresh_success' }), true);
  assert.deepEqual(writes, [{
    provider: 'codex',
    accountId: '1',
    runtimeState: null,
    baseState: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: '',
      displayName: 'user@example.com'
    }
  }]);
});

test('account state service accepts verified api key config as runtime clear evidence', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          account_id: '1',
          status: 'up',
          configured: true,
          api_key_mode: false,
          display_name: 'proxy.example.com'
        };
      },
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        writes.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.clearRuntimeBlock('codex', '1', {
    evidence: 'api_key_config_verified',
    configured: true,
    apiKeyMode: true,
    authMode: 'api-key',
    displayName: 'proxy.example.com'
  }), true);
  assert.deepEqual(writes, [{
    provider: 'codex',
    accountId: '1',
    runtimeState: null,
    baseState: {
      status: 'up',
      configured: true,
      apiKeyMode: true,
      authMode: 'api-key',
      displayName: 'proxy.example.com'
    }
  }]);
});

test('account state service records runtime failures with merged base state', () => {
  const writes = [];
  const service = createAccountStateService({
    accountStateIndex: {
      getAccountState() {
        return {
          account_id: '2',
          status: 'down',
          configured: false,
          api_key_mode: false,
          auth_mode: 'oauth-browser',
          display_name: 'old@example.com'
        };
      },
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        writes.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    }
  });

  assert.equal(service.recordRuntimeFailure('codex', '2', {
    authInvalidUntil: 123,
    lastFailureKind: 'auth_invalid'
  }, {
    configured: true,
    displayName: 'new@example.com'
  }), true);

  assert.deepEqual(writes[0], {
    provider: 'codex',
    accountId: '2',
    runtimeState: {
      authInvalidUntil: 123,
      lastFailureKind: 'auth_invalid'
    },
    baseState: {
      status: 'down',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      displayName: 'new@example.com'
    }
  });
});
