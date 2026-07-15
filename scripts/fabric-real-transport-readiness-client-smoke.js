#!/usr/bin/env node
'use strict';

const {
  DEFAULT_ENDPOINT,
  DEFAULT_NODE_ID,
  DEFAULT_PURPOSE,
  DEFAULT_TIMEOUT_MS,
  buildReadinessUrl,
  evaluateReport,
  formatReport,
  parseArgs,
  runTransportReadinessClientSmoke,
  selectReadyProfile
} = require('../lib/cli/services/fabric/transport-readiness-client');

function showHelp() {
  console.log(`AIH Fabric transport readiness

Usage:
  node scripts/fabric-real-transport-readiness-client-smoke.js [options]

Options:
  --ai-home-dir <path>          AIH home containing app-state.db.
  --endpoint <url>              Server profile endpoint, default ${DEFAULT_ENDPOINT}.
  --profile-id <id>             Server profile id to use.
  --node-id <id>                Fabric node id, default ${DEFAULT_NODE_ID}.
  --purpose <value>             Readiness purpose, default ${DEFAULT_PURPOSE}.
  --timeout-ms <n>              Request timeout, default ${DEFAULT_TIMEOUT_MS}.
  --diagnostics-file <path>     Write redacted readiness report JSON.
  --no-require-relay-measurement
                                Do not fail when relay measurement is absent.
  --json                        Print JSON only.
  -h, --help                    Show this help.

This readiness check is read-only. It uses the selected Server profile
Management Key, checks that unauthenticated readiness is rejected, and then reads
the protected readiness endpoint on the configured server profile. Device
tokens are never printed in the report.
`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runTransportReadinessClientSmoke(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    const code = String((error && error.code) || 'fabric_transport_readiness_client_smoke_failed');
    const detail = error && error.detail ? ` ${error.detail}` : '';
    console.error(`[fabric-real-transport-readiness-client-smoke] ${code}: ${String(error && error.message || error)}${detail}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_NODE_ID,
  buildReadinessUrl,
  evaluateReport,
  formatReport,
  parseArgs,
  runTransportReadinessClientSmoke,
  selectReadyProfile
};
