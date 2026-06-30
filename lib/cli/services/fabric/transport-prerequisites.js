'use strict';

const {
  formatReport,
  parseArgs,
  runPrerequisiteAudit
} = require('../../../../scripts/fabric-m6-prerequisite-audit');
const {
  applyTransportConfigDefaults
} = require('./transport-config');

async function runFabricTransportPrerequisitesCommand(args = [], deps = {}) {
  const commandArgs = Array.isArray(args) ? args : [];
  const parsedOptions = parseArgs(commandArgs, deps.env || process.env);
  const merged = (deps.applyTransportConfigDefaults || applyTransportConfigDefaults)(
    parsedOptions,
    commandArgs,
    deps
  );
  const options = merged.options;
  const report = await (deps.runPrerequisiteAudit || runPrerequisiteAudit)(options, deps);
  const promotionReady = Boolean(report && report.summary && report.summary.promotionReady);
  return {
    ...report,
    transportConfig: merged.source,
    json: options.json === true,
    exitOk: options.failOnBlocked === true ? promotionReady : report && report.ok !== false
  };
}

function formatFabricTransportPrerequisitesReport(report = {}) {
  return formatReport(report);
}

module.exports = {
  formatFabricTransportPrerequisitesReport,
  runFabricTransportPrerequisitesCommand
};
