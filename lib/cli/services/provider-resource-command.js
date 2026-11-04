'use strict';

const { createProviderResourceDoctor } = require('../../native-resources/provider-resource-doctor');
const { createManagedResourceStore } = require('../../native-resources/managed-resource-store');
const { runProviderListCommand } = require('./profile/provider-listing');

const USAGE = `Usage: aih provider <capabilities|doctor|ls> [--json]

  capabilities [--json]  Show every provider resource boundary and imported-host gap
  doctor [--json]        Add local runtime availability and managed-resource state
  ls [pattern...]        List providers with account counts and CLI availability
                         Patterns accept * and ? (quote them so the shell keeps them),
                         e.g. aih provider ls '*buddy*'
`;

async function runProviderResourceCommand(rawArgs = [], context = {}) {
  const args = rawArgs.slice(1).map(String);
  const command = args.shift();
  const output = context.consoleImpl || console;
  if (!['capabilities', 'doctor', 'ls'].includes(command) || args.includes('--help') || args.includes('-h')) {
    output.log(USAGE);
    return 0;
  }
  // 目录查询与账号列表共用 provider-scope.js 的匹配规则（见 profile/provider-listing.js）。
  if (command === 'ls') {
    return runProviderListCommand(args, { output, aiHomeDir: context.aiHomeDir });
  }
  const json = args.includes('--json');
  try {
    const managed = context.aiHomeDir ? createManagedResourceStore({ aiHomeDir: context.aiHomeDir }).get() : { resources: [] };
    const report = createProviderResourceDoctor({ ...context, managed })[command]();
    if (json) output.log(JSON.stringify(report));
    else {
      output.log(`Provider ${command}`);
      for (const row of report.providers) output.log(`${row.provider}  runtime:${row.runtime.available ? 'available' : 'unavailable'}  plugin:${row.resources.plugin.state}  skill:${row.resources.skill.state}  mcp:${row.resources.mcp.state}`);
      for (const row of report.hostAdapters) output.log(`host/${row.host}  ${row.state}  ${row.reason}`);
    }
    return report.healthy === false ? 1 : 0;
  } catch (error) {
    output.error(json ? JSON.stringify({ ok: false, error: error.code || error.message }) : `[aih provider] ${error.code || error.message}`);
    return 1;
  }
}

module.exports = { runProviderResourceCommand };
