'use strict';

// `aih claim` 命令层：参数解析、账号枚举与退出码。
// 命令层不碰协议细节（那在 test/activity-claim.test.js），这里只锁调度语义。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  resolveAccountSelection,
  resolveProviders,
  runClaimCommand,
  summarize
} = require('../lib/cli/services/claim/claim-command');

function createLogger() {
  const lines = [];
  return {
    lines,
    consoleImpl: {
      log: (value) => lines.push(String(value)),
      error: (value) => lines.push(String(value))
    }
  };
}

test('parseArgs accepts providers, account and flags in any order', () => {
  assert.deepEqual(parseArgs(['qoder', '--dry-run', '--account', '2', '--json']), {
    providers: ['qoder'],
    account: '2',
    json: true,
    quiet: false,
    dryRun: true,
    help: false,
    appVersion: '',
    captchaBrowser: '',
    timeoutMs: null
  });

  assert.deepEqual(parseArgs(['zcode', '3']), {
    providers: ['zcode'],
    account: '3',
    json: false,
    quiet: false,
    dryRun: false,
    help: false,
    appVersion: '',
    captchaBrowser: '',
    timeoutMs: null
  });
});

test('parseArgs rejects unknown options and ambiguous bare ids', () => {
  assert.deepEqual(parseArgs(['--nope']), { error: 'unknown_option:--nope' });
  assert.equal(parseArgs(['qoder', 'zcode', '1']).error, 'ambiguous_account_id: pass exactly one provider and one id');
});

test('resolveProviders defaults to every registered provider and expands all', () => {
  assert.deepEqual(resolveProviders([]), { providers: ['qoder', 'qodercn', 'zcode'] });
  assert.deepEqual(resolveProviders(['all']), { providers: ['qoder', 'qodercn', 'zcode'] });
  assert.deepEqual(resolveProviders(['zcode', 'zcode']), { providers: ['zcode'] });
  assert.equal(resolveProviders(['nope']).error, 'unknown_provider:nope: expected qoder, qodercn, zcode or all');
});

test('resolveAccountSelection maps a CLI id through the alias table', () => {
  const records = [
    { accountRef: 'acct_a', provider: 'qoder' },
    { accountRef: 'acct_b', provider: 'qoder' }
  ];
  const selection = resolveAccountSelection({
    provider: 'qoder',
    account: '2',
    records,
    listCliAccountRefRecords: () => [
      { cliAccountId: '1', accountRef: 'acct_a' },
      { cliAccountId: '2', accountRef: 'acct_b' }
    ]
  });
  assert.deepEqual(selection.records.map((record) => record.accountRef), ['acct_b']);
  assert.equal(selection.unknownAccount, '');
});

test('resolveAccountSelection reports unknown ids instead of silently claiming everything', () => {
  const selection = resolveAccountSelection({
    provider: 'qoder',
    account: '9',
    records: [{ accountRef: 'acct_a' }],
    listCliAccountRefRecords: () => [{ cliAccountId: '1', accountRef: 'acct_a' }]
  });
  assert.deepEqual(selection.records, []);
  assert.equal(selection.unknownAccount, '9');
});

test('runClaimCommand returns 0 and a machine-readable payload when claims succeed', async () => {
  const { consoleImpl, lines } = createLogger();
  const code = await runClaimCommand(['qoder', '--json'], {
    aiHomeDir: '/tmp/aih-home',
    consoleImpl,
    listAccountCredentialRecords: () => [
      { accountRef: 'acct_a', provider: 'qoder', env: { QODER_PERSONAL_ACCESS_TOKEN: 'x' } }
    ],
    listCliAccountRefRecords: () => [{ cliAccountId: '1', accountRef: 'acct_a' }],
    runActivityClaim: async () => ({ provider: 'qoder', accountRef: 'acct_a', status: 'claimed', credits: 100 })
  });

  assert.equal(code, 0);
  const payload = JSON.parse(lines.join('\n'));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.claimed, 1);
  assert.equal(payload.results[0].accountRef, 'acct_a');
});

test('runClaimCommand returns 1 when any account fails', async () => {
  const { consoleImpl, lines } = createLogger();
  const code = await runClaimCommand(['qoder'], {
    aiHomeDir: '/tmp/aih-home',
    consoleImpl,
    listAccountCredentialRecords: () => [{ accountRef: 'acct_a', provider: 'qoder' }],
    listCliAccountRefRecords: () => [],
    runActivityClaim: async () => ({
      provider: 'qoder',
      accountRef: 'acct_a',
      status: 'error',
      error: 'qoder_token_missing'
    })
  });

  assert.equal(code, 1);
  assert.match(lines.join('\n'), /failed/);
  assert.match(lines.join('\n'), /qoder_token_missing/);
});

test('runClaimCommand skips providers without accounts and surfaces unknown accounts', async () => {
  const { consoleImpl, lines } = createLogger();
  const code = await runClaimCommand(['qoder', 'zcode', '--account', '7'], {
    aiHomeDir: '/tmp/aih-home',
    consoleImpl,
    listAccountCredentialRecords: (_fs, _home, provider) => (
      provider === 'qoder' ? [{ accountRef: 'acct_a', provider: 'qoder' }] : []
    ),
    listCliAccountRefRecords: () => [{ cliAccountId: '1', accountRef: 'acct_a' }],
    runActivityClaim: async () => {
      throw new Error('must not run for an unknown account');
    }
  });

  assert.equal(code, 1);
  assert.match(lines.join('\n'), /account_not_found/);
});

test('runClaimCommand quiet mode only prints errors', async () => {
  const { consoleImpl, lines } = createLogger();
  await runClaimCommand(['qoder', '--quiet'], {
    aiHomeDir: '/tmp/aih-home',
    consoleImpl,
    listAccountCredentialRecords: () => [{ accountRef: 'acct_a', provider: 'qoder' }],
    listCliAccountRefRecords: () => [],
    runActivityClaim: async () => ({ provider: 'qoder', accountRef: 'acct_a', status: 'claimed', credits: 100 })
  });

  const output = lines.join('\n');
  assert.ok(!output.includes('acct_a'), 'claimed accounts are hidden in quiet mode');
});

test('runClaimCommand --help exits 0 and prints usage', async () => {
  const { consoleImpl, lines } = createLogger();
  const code = await runClaimCommand(['--help'], { aiHomeDir: '/tmp/aih-home', consoleImpl });
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /aih claim/);
});

test('summarize counts every terminal status', () => {
  assert.deepEqual(
    summarize([
      { status: 'claimed' },
      { status: 'already_claimed' },
      { status: 'nothing_claimable' },
      { status: 'dry_run' },
      { status: 'not_applicable' },
      { status: 'error' },
      { status: 'no_accounts' }
    ]),
    {
      accounts: 6,
      claimed: 1,
      alreadyClaimed: 1,
      nothingClaimable: 1,
      dryRun: 1,
      notApplicable: 1,
      failed: 1
    }
  );
});
