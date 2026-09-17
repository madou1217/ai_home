'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { registerAccountIdentity } = require('../../lib/account/account-registration');
const { codexOAuthAuth } = require('../codex-identity-fixtures');
const { writeAccountNativeAuth } = require('../../lib/server/account-credential-store');
const { writeDefaultAccountRef } = require('../../lib/account/default-account-store');
const { openAppStateDatabase } = require('../../lib/server/app-state-store');
const { createMaintenancePlan, applyMaintenancePlan } = require('../../lib/cli/services/account/oauth-identity-maintenance');

// Synthetic account data only; each test owns every database and runtime path.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-maintenance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Parallel files run real process probes. Each owned fixture therefore needs
  // a distinct upstream identity as well as a distinct temporary data directory.
  const fixtureID = path.basename(root);
  const email = `${fixtureID}@example.invalid`.toLowerCase();
  const ref = registerAccountIdentity(fs, root, { provider: 'codex', identitySeed: `oauth:codex:${email}` }).accountRef;
  writeAccountNativeAuth(fs, root, ref, { auth: codexOAuthAuth({ email, userId: `stable-${fixtureID}` }) });
  writeDefaultAccountRef(fs, root, 'codex', ref);
  const runtime = path.join(root, 'run/codex-desktop', ref);
  fs.mkdirSync(path.join(runtime, '.codex'), { recursive: true });
  const config = path.join(runtime, '.codex/config.toml');
  fs.writeFileSync(config, `[model_providers.aih_server.http_headers]\n"X-Account-Ref" = "${ref}"\n`, { mode: 0o600 });
  const shared = path.join(root, 'shared-history'); fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'must-not-change.jsonl'), `{"text":"history ${ref}"}\n`);
  fs.symlinkSync(shared, path.join(runtime, '.codex/sessions'));
  fs.mkdirSync(path.join(root, 'run/codex-app-server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'run/codex-app-server', `chat-${ref}.json`), JSON.stringify({ accountRef: ref, runtimeScope: `chat-${ref}`, socket: `aih-codexchat-${ref.replace('_', '')}` }));
  const db = openAppStateDatabase(fs, root);
  db.exec('CREATE TABLE chat_runtime_fixture(account_ref TEXT, payload_json TEXT); CREATE TABLE model_usage_records(event_key TEXT UNIQUE, account_ref TEXT, total_tokens INTEGER)');
  db.prepare('INSERT INTO chat_runtime_fixture VALUES(?,?)').run(ref, ` {"accountRef":"${ref}","runtimeDir":"${runtime}","content":"keep ${ref}","n":9223372036854775807}`);
  db.prepare('INSERT INTO model_usage_records VALUES(?,?,?)').run(`gateway:${ref}:request-fixture`, ref, 1234);
  db.close();
  const plan = () => createMaintenancePlan(root, ['codex']);
  const apply = p => applyMaintenancePlan(p, { confirmDigest: p.digest, leaseOptions: { assertQuiet() {} } });
  return { root, ref, config, runtime, shared, plan, apply };
}

module.exports = { fixture };
