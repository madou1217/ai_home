'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { collectCliEntries } = require('./cli');
const { collectWebEntries } = require('./web');
const { collectGatewayRoutes } = require('../collect-gateway-routes');

const ROOT = path.resolve(__dirname, '../..');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function collectProductInventory(options = {}) {
  const web = collectWebEntries(ROOT);
  const entries = [...collectCliEntries(), ...web.entries];
  const manifest = readJSON('lib/generated/route-ownership.json');
  for (const contract of manifest.entries) {
    for (const [runtime, routes] of [['go', contract.go_routes || []], ['node', contract.node_routes || []]]) {
      for (const route of routes) {
        const entry = `${(route.methods || ['*']).join('|')} ${route.path}`;
        entries.push({
          id: `contract:${contract.id}:${runtime}:${route.transport}:${entry}`,
          surface: 'api', entry, transport: route.transport, runtime,
          contract: contract.id, owner: contract.production_owner,
          evidence: 'ownership_contract', source: 'contracts/routeownership/contract.go'
        });
      }
    }
  }
  const gateway = collectGatewayRoutes();
  for (const runtime of ['node', 'go']) {
    for (const route of gateway[runtime].routes.filter((item) => item.kind === 'endpoint')) {
      const entry = `${route.methods.join('|')} ${route.path}`;
      entries.push({
        id: `source:${runtime}:${route.transport}:${entry}:${route.source.file}:${route.source.line}`,
        surface: 'api', entry, transport: route.transport, runtime,
        evidence: route.evidence_kind, source: route.source.file, line: route.source.line
      });
    }
  }
  for (const provider of readJSON('contracts/providers/manifest.json').providers) {
    for (const capability of provider.capabilities || []) entries.push({
      id: `provider:${provider.id}:${capability}`,
      surface: 'provider', entry: `${provider.id}.${capability}`, provider: provider.id,
      evidence: 'capability_contract', source: 'core/providers/builtins.go'
    });
  }
  for (const area of fs.readdirSync(path.join(ROOT, 'web/src/features'), { withFileTypes: true })) {
    if (area.isDirectory()) entries.push({
      id: `feature-area:${area.name}`, surface: 'feature-area', entry: area.name,
      evidence: 'directory_only', source: `web/src/features/${area.name}`
    });
  }
  const extraUnresolved = [];
  if (options.goAstFile) {
    const report = JSON.parse(fs.readFileSync(options.goAstFile, 'utf8'));
    if (report.mode !== 'read_only_go_ast_registration_inventory' || !Array.isArray(report.entries)) {
      throw new Error('go_ast_inventory_invalid');
    }
    for (const route of report.entries) {
      entries.push({
        id: `go-ast:${route.evidence}:${route.method}:${route.path}:${route.source.file}:${route.source.line}`,
        surface: 'api', entry: `${route.method} ${route.path}`, runtime: 'go',
        evidence: route.evidence, source: route.source.file, line: route.source.line,
        function: route.source.function, expression: route.source.expression
      });
    }
    extraUnresolved.push(...(report.unresolved || []).map((item) => ({ ...item, collector: 'go_ast' })));
  } else {
    extraUnresolved.push({ reason: 'Go AST registration report not attached. Run go run ./cmd/route-entry-inventory and pass --go-ast <file>.' });
  }
  const byId = new Map();
  for (const entry of entries) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, { ...entry, auditStatus: 'unreviewed', intentStatus: 'needs_source_confirmation', runtimeStatus: 'not_verified' });
  }
  const sorted = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const counts = {};
  for (const entry of sorted) counts[entry.surface] = (counts[entry.surface] || 0) + 1;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '',
    inventoryDigest: crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
    counts,
    coverageNote: 'These are entry/capability evidence rows, not a count of verified features. Contract/source routes intentionally coexist until reviewed and linked.',
    unresolved: [
      ...web.unresolved,
      ...extraUnresolved,
      { reason: 'CLI declarations must be reconciled against Node and Go executable routers, help and option-value behavior.' },
      { reason: 'UI actions, native entrypoints, installations, backup/migration and dynamic route registrations require manual leaf-level mapping.' },
      { reason: 'Source route scanner is not a complete runtime/AST router enumeration. Missing entries must not be interpreted as absent features.' }
    ],
    entries: sorted
  };
}

if (require.main === module) {
  // stdout only: the caller chooses the snapshot destination; never overwrite a reviewed ledger.
  const option = process.argv.indexOf('--go-ast');
  if (option >= 0 && !process.argv[option + 1]) throw new Error('go_ast_path_required');
  process.stdout.write(`${JSON.stringify(collectProductInventory({ goAstFile: option >= 0 ? process.argv[option + 1] : '' }), null, 2)}\n`);
}

module.exports = { collectProductInventory };
