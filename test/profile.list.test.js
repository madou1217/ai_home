const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileListService } = require('../lib/cli/services/profile/list');

function createTempProfiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-profile-list-'));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'codex', '1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '2'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'codex', '3'), { recursive: true });
  return { root, profilesDir };
}

test('showLsHelp includes Ctrl+C quit hint', () => {
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 2,
      getToolAccountIds: () => ['1', '2', '3'],
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
  const { root, profilesDir } = createTempProfiles();
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
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 2,
      getToolAccountIds: () => ['1', '2', '3'],
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, pDir) => ({ configured: true, accountName: path.basename(pDir) }),
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 10,
      getToolAccountIds: () => ['1', '2', '3'],
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, pDir) => ({ configured: true, accountName: `u-${path.basename(pDir)}` }),
      formatUsageLabel: (_tool, id) => `\x1b[36m[Remaining: ${id}.0%]\x1b[0m`,
      refreshIndexedStateForAccount: (_tool, id) => ({
        remainingPct: id === '2' ? 0 : 50
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
  const { root, profilesDir } = createTempProfiles();
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
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 10,
      getToolAccountIds: () => ['1'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '1',
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

test('listProfiles includes filesystem account IDs even when state index is missing them', () => {
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1', '2', '3'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '1',
          configured: true,
          apiKeyMode: false,
          remainingPct: 90,
          displayName: 'u-1'
        }]
      }),
      checkStatus: (_tool, pDir) => ({ configured: true, accountName: `u-${path.basename(pDir)}` }),
      formatUsageLabel: () => '',
      refreshIndexedStateForAccount: (_tool, id) => ({
        remainingPct: id === '2' ? 66 : 77
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    fs.writeFileSync(path.join(profilesDir, 'codex', '.aih_default'), '1', 'utf8');
    fs.writeFileSync(path.join(root, 'codex-desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountId: '2'
    }), 'utf8');
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} }, env: {} },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1', '2', '3'],
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, pDir) => ({ configured: true, accountName: `u-${path.basename(pDir)}` }),
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1', '2', '3'],
      getAccountStateIndex: () => ({ listStates: () => [] }),
      checkStatus: (_tool, pDir) => ({ configured: true, accountName: `u-${path.basename(pDir)}` }),
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['2'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '2',
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '1',
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1'],
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

test('listProfiles prefers profile status file when refreshed row omits status', () => {
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    fs.writeFileSync(path.join(profilesDir, 'codex', '1', '.aih_status'), 'down\n', 'utf8');
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '1',
          status: 'up',
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
  const { root, profilesDir } = createTempProfiles();
  const logs = [];
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const service = createProfileListService({
      fs,
      path,
      processObj: { stdout: { isTTY: false, write: () => {} } },
      readline: { keyIn: () => '' },
      profilesDir,
      cliConfigs: { codex: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1'],
      getAccountStateIndex: () => ({
        listStates: () => [{
          accountId: '1',
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-profile-list-agy-runtime-'));
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(path.join(profilesDir, 'agy', '1'), { recursive: true });
  const logs = [];
  const oldLog = console.log;
  const row = {
    accountId: '1',
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
      profilesDir,
      cliConfigs: { agy: {} },
      listPageSize: 20,
      getToolAccountIds: () => ['1'],
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
