const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileListService } = require('../lib/cli/services/profile/list');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

function createTempAccounts(provider = 'codex', cliAccountIds = ['1', '2', '3']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-profile-list-'));
  const accountRefs = new Map();
  const cliIdsByAccountRef = new Map();
  cliAccountIds.forEach((cliAccountId) => {
    const accountRef = upsertAccountRef(fs, root, {
      provider,
      cliAccountId,
      identitySeed: `test:${provider}:${root}:${cliAccountId}`
    });
    accountRefs.set(cliAccountId, accountRef);
    cliIdsByAccountRef.set(accountRef, cliAccountId);
  });
  return {
    root,
    aiHomeDir: root,
    accountRefs,
    getCliAccountId: (accountRef) => cliIdsByAccountRef.get(accountRef) || ''
  };
}

test('showLsHelp includes Ctrl+C quit hint', () => {
  const { root, aiHomeDir } = createTempAccounts();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 2,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: () => ({ configured: true, accountName: 'u' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => {}
    });
    service.showLsHelp('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.match(joined, /Ctrl\+C/);
});

test('interactive pager treats Ctrl+C as quit and prints omitted count', () => {
  const { root, aiHomeDir, getCliAccountId } = createTempAccounts();
  const logs = [];
  const writes = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: true, write: (s) => writes.push(String(s)) } },
      readline: { keyIn: () => String.fromCharCode(3) },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 2,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, accountRef) => ({ configured: true, accountName: getCliAccountId(accountRef) }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => {}
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joinedWrites = writes.join('');
  const joinedLogs = logs.join('\n');
  assert.match(joinedWrites, /Ctrl\+C=quit/);
  assert.match(joinedLogs, /omitted 1 accounts/);
});

test('listProfiles hides accounts with remaining 0 by default', () => {
  const { root, aiHomeDir, getCliAccountId } = createTempAccounts();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 10,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, accountRef) => ({ configured: true, accountName: `u-${getCliAccountId(accountRef)}` }),
      formatUsageLabel: (_tool, accountRef) => `\x1b[36m[Remaining: ${getCliAccountId(accountRef)}.0%]\x1b[0m`,
      refreshIndexedStateForAccount: (_tool, accountRef) => ({
        remainingPct: getCliAccountId(accountRef) === '2' ? 0 : 50
      })
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.match(joined, /Remaining:/);
  assert.match(joined, /Account ID: .*1/);
  assert.doesNotMatch(joined, /\x1b\[36m2\x1b\[0m/);
});

test('listProfiles does not force snapshot refresh for configured accounts with unknown remaining', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('codex', ['1']);
  const logs = [];
  const refreshCalls = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 10,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('1'),
          configured: true,
          apiKeyMode: false,
          remainingPct: null,
          displayName: 'u-1'
        }]
      }),
      checkStatus: () => ({ configured: true, accountName: 'u-1' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: (_tool, _id, opts) => {
        refreshCalls.push(opts);
        return { remainingPct: 42 };
      }
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].refreshSnapshot, false);
  assert.match(logs.join('\n'), /Remaining: 42.0%/);
});

test('listProfiles includes DB accounts even when state index is missing them', () => {
  const { root, aiHomeDir, accountRefs, getCliAccountId } = createTempAccounts();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('1'),
          configured: true,
          apiKeyMode: false,
          remainingPct: 90,
          displayName: 'u-1'
        }]
      }),
      checkStatus: (_tool, accountRef) => ({ configured: true, accountName: `u-${getCliAccountId(accountRef)}` }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: (_tool, accountRef) => ({
        remainingPct: getCliAccountId(accountRef) === '2' ? 66 : 77
      })
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.match(joined, /Account ID: .*1/);
  assert.match(joined, /Account ID: .*2/);
  assert.match(joined, /Account ID: .*3/);
});

test('listProfiles marks default and codex mobile account roles', () => {
  const { root, aiHomeDir, accountRefs, getCliAccountId } = createTempAccounts();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    writeDefaultAccountRef(fs, aiHomeDir, 'codex', accountRefs.get('1'));
    const desktopStateDir = path.join(aiHomeDir, 'run', 'codex');
    fs.mkdirSync(desktopStateDir, { recursive: true });
    fs.writeFileSync(path.join(desktopStateDir, 'desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountRef: accountRefs.get('2')
    }), 'utf8');
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} }, env: {} },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, accountRef) => ({ configured: true, accountName: `u-${getCliAccountId(accountRef)}` }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({ remainingPct: 88 })
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.match(joined, /Account ID: .*\x1b\[36m1\x1b\[0m.*★ Default/);
  assert.match(joined, /Account ID: .*\x1b\[36m2\x1b\[0m.*📱 Mobile/);
});

test('listProfiles supports filtering by specific account id', () => {
  const { root, aiHomeDir, getCliAccountId } = createTempAccounts();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, accountRef) => ({ configured: true, accountName: `u-${getCliAccountId(accountRef)}` }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({ remainingPct: 88 })
    });
    service.listProfiles('codex', '2');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.doesNotMatch(joined, /Account ID:\s+\x1b\[36m1\x1b\[0m/);
  assert.match(joined, /Account ID:\s+\x1b\[36m2\x1b\[0m/);
  assert.doesNotMatch(joined, /Account ID:\s+\x1b\[36m3\x1b\[0m/);
});

test('listProfiles keeps remaining 0 account when filtering by id', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('codex', ['2']);
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('2'),
          configured: true,
          apiKeyMode: false,
          remainingPct: 0,
          displayName: 'u-2'
        }]
      }),
      checkStatus: () => ({ configured: true, accountName: 'u-2' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({
        configured: true,
        apiKeyMode: false,
        quotaStatus: 'exhausted',
        remainingPct: 0
      })
    });
    service.listProfiles('codex', '2');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const joined = logs.join('\n');
  assert.match(joined, /Account ID:\s+\x1b\[36m2\x1b\[0m/);
  assert.match(joined, /Remaining: 0.0%/);
});

test('listProfiles prints Remaining: Unknown for active oauth accounts without usage snapshot', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('codex', ['1']);
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('1'),
          configured: true,
          apiKeyMode: false,
          remainingPct: null,
          displayName: 'u-1'
        }]
      }),
      checkStatus: () => ({ configured: true, accountName: 'u-1' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({ remainingPct: null })
    });
    service.listProfiles('codex');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.match(logs.join('\n'), /Remaining: Unknown/);
});

test('listProfiles shows pending login + unconfigured remaining for unconfigured account', () => {
  const { root, aiHomeDir } = createTempAccounts('codex', ['1']);
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: () => ({ configured: false, accountName: 'Unknown' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({
        configured: false,
        apiKeyMode: false,
        remainingPct: null
      })
    });
    service.listProfiles('codex', '1');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const joined = logs.join('\n');
  assert.match(joined, /Pending Login/);
  assert.match(joined, /Unconfigured \(login required\)/);
});

test('listProfiles preserves indexed DB status when refreshed row omits status', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('codex', ['1']);
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('1'),
          status: 'down',
          configured: true,
          apiKeyMode: false,
          remainingPct: 55,
          displayName: 'u-1'
        }]
      }),
      checkStatus: () => ({ configured: true, accountName: 'u-1' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({
        configured: true,
        apiKeyMode: false,
        remainingPct: 55
      })
    });
    service.listProfiles('codex', '1');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.match(logs.join('\n'), /关闭/);
});

test('listProfiles shows auth expired instead of stale remaining', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('codex', ['1']);
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountRef: accountRefs.get('1'),
          status: 'up',
          configured: true,
          apiKeyMode: false,
          remainingPct: 95,
          displayName: 'u-1',
          runtimeState: {
            authInvalidUntil: Date.now() + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'token_expired'
          }
        }]
      }),
      checkStatus: () => ({ configured: true, accountName: 'u-1' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => ({
        configured: true,
        apiKeyMode: false,
        remainingPct: 95
      })
    });
    service.listProfiles('codex', '1');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.match(joined, /Auth Expired/);
  assert.match(joined, /Auth: expired/);
  assert.doesNotMatch(joined, /Remaining: 95\.0%/);
});

test('listProfiles re-reads runtime state after indexed refresh clears agy auth block', () => {
  const { root, aiHomeDir, accountRefs } = createTempAccounts('agy', ['1']);
  const logs = [];
  const oldLog = console.log;
  const row = {
    accountRef: accountRefs.get('1'),
    status: 'up',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    displayName: 'agy@example.com',
    runtimeState: {
      authInvalidUntil: Date.now() + 60_000,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: 'auth_invalid_reauth_required'
    }
  };
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      aiHomeDir,
      cliConfigs: { agy: {} },
      listPageSize: 20,
      getAccountStateIndex: () => ({
        listStates: () => [row],
        getAccountState: () => row
      }),
      checkStatus: () => ({ configured: true, accountName: 'agy@example.com' }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: () => {
        row.runtimeState = null;
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: null
        };
      }
    });
    service.listProfiles('agy', '1');
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }

  const joined = logs.join('\n');
  assert.doesNotMatch(joined, /Auth Expired/);
  assert.match(joined, /Active/);
});
