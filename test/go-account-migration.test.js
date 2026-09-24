'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ensureGoServerBinary, seedNodeAccounts } = require('./helpers/go-bridge');
const {
  RESOLUTION,
  applyAccountMigration,
  planAccountMigration,
  verifyAccountMigration
} = require('../lib/account/go-bridge/account-migration');
const { readGoAccounts } = require('../lib/account/go-bridge/go-account-store-reader');

const goBinary = ensureGoServerBinary();
const skip = goBinary ? false : 'Go toolchain unavailable: cannot build the real aih-server';

function byOldRef(ledger) {
  return new Map(ledger.entries.map((entry) => [entry.old_account_ref, entry]));
}

test('Node -> Go account migration: plan rehearses in scratch, apply imports, verify matches field by field', { skip, timeout: 120000 }, async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-migration-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const refs = seedNodeAccounts(aiHomeDir);

  const { ledger, file } = await planAccountMigration({ aiHomeDir, goBinary });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'aih.db')), false, 'plan must not touch the real aih.db');
  const entries = byOldRef(ledger);

  // OAuth 身份两端一致 -> accountRef 不变；静态凭据种子不同 -> rekey 并有 Go 预测值佐证。
  assert.equal(entries.get(refs.codexTeam).resolution, RESOLUTION.sameRef);
  assert.equal(entries.get(refs.codexTeam).new_account_ref, refs.codexTeam);
  assert.deepEqual(entries.get(refs.codexTeam).workspace, { workspaceId: 'ws-team', upstreamAccountId: 'ws-team' });
  assert.deepEqual(entries.get(refs.codexExplicit).workspace, { workspaceId: 'ws-explicit', upstreamAccountId: 'ws-explicit' });
  assert.equal(entries.get(refs.claudeOauth).resolution, RESOLUTION.sameRef);
  assert.equal(entries.get(refs.agy).resolution, RESOLUTION.sameRef);
  for (const key of ['codexKey', 'claudeKey', 'claudeToken']) {
    const entry = entries.get(refs[key]);
    assert.equal(entry.resolution, RESOLUTION.rekeyed, key);
    assert.equal(entry.prediction_matches, true, `${key}: JS prediction must equal Go's real ref`);
  }
  assert.deepEqual(entries.get(refs.codexKey).lossy_fields, ['OPENAI_WIRE_API']);

  // Node 的两个「官方地址」API Key 账号在 Go 是同一身份：第二个归并，不重复建号。
  const official = [entries.get(refs.codexOfficialEmpty), entries.get(refs.codexOfficialExplicit)];
  assert.equal(official[0].new_account_ref, official[1].new_account_ref);
  assert.deepEqual(official.map((entry) => entry.resolution).sort(), [RESOLUTION.merged, RESOLUTION.rekeyed].sort());

  // Go 无法承接的账号显式列出原因，不静默丢弃。
  assert.equal(entries.get(refs.codexConflict).resolution, RESOLUTION.unsupported);
  assert.equal(entries.get(refs.codexConflict).reason, 'codex_workspace_account_id_mismatch');
  assert.equal(entries.get(refs.opencodeKey).resolution, RESOLUTION.unsupported);
  assert.equal(entries.get(refs.opencodeKey).reason, 'go_has_no_static_credential_for_provider');

  assert.deepEqual(ledger.summary, {
    total: 11,
    same_ref: 4,
    rekeyed: 4,
    merged_into_existing: 1,
    unsupported_in_go: 2,
    rejected_by_go: 0
  });
  assert.equal(ledger.defaults.codex.new_account_ref, refs.codexTeam);
  assert.equal(ledger.defaults.claude.new_account_ref, refs.claudeOauth);

  const applied = await applyAccountMigration({ aiHomeDir, goBinary });
  assert.deepEqual(applied.failures, []);

  const verification = verifyAccountMigration({ aiHomeDir });
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.counts, {
    node_accounts: 11,
    ledger_migrated: 9,
    unique_go_accounts_expected: 8,
    go_accounts_present: 8,
    go_accounts_total: 8,
    go_only_accounts: 0
  });

  const go = readGoAccounts(aiHomeDir);
  const goByRef = new Map(go.accounts.map((account) => [account.accountRef, account]));
  assert.equal(goByRef.get(entries.get(refs.claudeKey).new_account_ref).enabled, false, 'Node status down -> Go disabled');
  assert.equal(goByRef.get(refs.codexTeam).credential.explicit_account_id, 'ws-team');
  assert.equal(goByRef.get(refs.codexExplicit).profile.account_id, 'ws-explicit');
  assert.equal(go.defaults.codex, refs.codexTeam);

  // apply 幂等：再跑一次不产生新账号，结果仍然核对通过。
  await applyAccountMigration({ aiHomeDir, goBinary });
  assert.equal(readGoAccounts(aiHomeDir).accounts.length, 8);
  assert.equal(verifyAccountMigration({ aiHomeDir }).ok, true);
});

test('Node -> Go account migration refuses a stale ledger and verify reports credential drift', { skip, timeout: 120000 }, async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-migration-drift-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const refs = seedNodeAccounts(aiHomeDir);
  await planAccountMigration({ aiHomeDir, goBinary });
  await applyAccountMigration({ aiHomeDir, goBinary });

  const { writeAccountCredentials } = require('../lib/server/account-credential-store');
  writeAccountCredentials(fs, aiHomeDir, refs.claudeToken, {
    ANTHROPIC_AUTH_TOKEN: 'tok-rotated',
    ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic',
    AIH_CLAUDE_CREDENTIAL_TYPE: 'auth-token'
  });

  await assert.rejects(() => applyAccountMigration({ aiHomeDir, goBinary }), (error) => error.code === 'ledger_stale');
  const verification = verifyAccountMigration({ aiHomeDir });
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((problem) => problem.problem === 'node_changed_since_plan'));
});
