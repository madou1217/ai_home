#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  createMaintenancePlan, applyMaintenancePlan, recoverMaintenance, writeMaintenancePlan
} = require('../lib/cli/services/account/oauth-identity-maintenance');

/** Composition root only: no credential or reference rewrite policy lives in CLI parsing. */
function parseArgs(argv) {
  const [action = 'help', ...tokens] = argv;
  if (!['plan', 'apply', 'recover', 'rollback', 'help', '--help'].includes(action)) throw new Error('unknown_maintenance_action');
  const options = { action };
  const allowed = new Set(['--ai-home', '--output', '--providers', '--plan', '--confirm', '--id']);
  for (let index = 0; index < tokens.length; index++) {
    const key = tokens[index];
    if (!allowed.has(key) || options[key.slice(2)] !== undefined || !tokens[index + 1] || tokens[index + 1].startsWith('--')) {
      throw new Error('invalid_maintenance_option');
    }
    options[key.slice(2)] = tokens[++index];
  }
  return options;
}

function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) throw new Error('maintenance_document_invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.action === 'help' || options.action === '--help') {
    process.stdout.write([
      'OAuth identity maintenance — read-only plan; live apply is not approved',
      'plan --ai-home PATH --output PRIVATE_PLAN [--providers codex,grok]',
      'apply --ai-home PATH --plan PRIVATE_PLAN --confirm PLAN_SHA256',
      'recover --ai-home PATH --id TRANSACTION_UUID --confirm PLAN_SHA256',
      'rollback --ai-home PATH --id TRANSACTION_UUID --confirm PLAN_SHA256',
      '',
      'Plan is read-only. Apply requires all AIH database writers to be stopped.',
      'No command kills clients, bypasses blockers or prints credentials.',
      'A crash leaves a persistent gate: recover reconciles the SQLite marker first.',
      ''
    ].join('\n'));
    return 0;
  }
  // Independent review rejected live apply (concurrent recovery lease, writer
  // exclusion and durability gaps). Keep this CLI read-only until those findings
  // have their own passing adversarial tests and an explicit re-review. There is
  // intentionally no environment flag or --force option to bypass this decision.
  if (options.action !== 'plan') throw new Error('live_migration_not_approved');
  if (!options['ai-home']) throw new Error('explicit_ai_home_required');
  const root = fs.realpathSync(path.resolve(options['ai-home']));
  if (options.action === 'plan') {
    if (!options.output) throw new Error('private_plan_output_required');
    const providers = (options.providers || 'codex,grok').split(',');
    const plan = createMaintenancePlan(root, providers);
    writeMaintenancePlan(path.resolve(options.output), plan);
    // Private plan carries mappings/content; stdout intentionally only describes
    // counts and classified blocker locations, never account credentials/content.
    process.stdout.write(JSON.stringify({
      status: plan.blockers.length ? 'blocked' : 'planned', digest: plan.digest,
      accountsToMigrate: plan.mapping.length,
      databaseCells: plan.database.changes.length,
      filesToEdit: plan.filesystem.edits.length,
      pathsToMove: plan.filesystem.moves.length,
      linksToRetarget: plan.filesystem.links.length,
      blockerCount: plan.blockers.length,
      blockerSamples: plan.blockers.slice(0, 20).map(({ provider, table, column, path: file, reason }) => ({ provider, table, column, path: file, reason })),
      planPath: path.resolve(options.output)
    }, null, 2) + '\n');
    return plan.blockers.length ? 2 : 0;
  }
  if (!/^[a-f0-9]{64}$/.test(options.confirm || '')) throw new Error('explicit_plan_digest_required');
  let result;
  if (options.action === 'apply') {
    if (!options.plan) throw new Error('private_plan_required');
    const plan = readPrivateJson(path.resolve(options.plan));
    if (plan.root !== root) throw new Error('maintenance_root_mismatch');
    result = applyMaintenancePlan(plan, { confirmDigest: options.confirm });
  } else {
    if (!/^[a-f0-9-]{36}$/.test(options.id || '')) throw new Error('maintenance_transaction_id_required');
    const journal = readPrivateJson(path.join(root, 'migration', `oauth-rekey-${options.id}`, 'journal.json'));
    if (journal.planDigest !== options.confirm) throw new Error('maintenance_digest_mismatch');
    result = recoverMaintenance(root, options.id, { rollback: options.action === 'rollback' });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    // Error messages in these adapters are code-owned constants. Do not print
    // nested causes, JSON documents, native process output or credentials.
    const code = /^[a-z][a-z0-9_]+$/.test(error.message || '') ? error.message : 'identity_maintenance_failed';
    process.stderr.write(JSON.stringify({ error: code, journalId: error.journalId }) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
