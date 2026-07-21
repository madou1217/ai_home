'use strict';

const {
  formatReport,
  parseArgs,
  runDurabilityGate
} = require('../../../../scripts/fabric-m6-relay-durability-gate');

async function runFabricTransportRelayDurabilityCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : []);
  const report = await (deps.runDurabilityGate || runDurabilityGate)(options, deps);
  return {
    ...report,
    json: options.json === true,
    exitOk: report && report.ok !== false
  };
}

function formatFabricTransportRelayDurabilityReport(report = {}) {
  return formatReport(report);
}

module.exports = {
  formatFabricTransportRelayDurabilityReport,
  runFabricTransportRelayDurabilityCommand
};
