'use strict';

const {
  formatReport,
  parseArgs,
  runPromotionGate
} = require('../../../../scripts/fabric-m6-promotion-gate');
const {
  applyTransportConfigDefaults
} = require('./transport-config');

async function runFabricTransportPromotionGateCommand(args = [], deps = {}) {
  const commandArgs = Array.isArray(args) ? args : [];
  const parsedOptions = parseArgs(commandArgs);
  const merged = (deps.applyTransportConfigDefaults || applyTransportConfigDefaults)(
    parsedOptions,
    commandArgs,
    deps
  );
  const options = merged.options;
  const report = await (deps.runPromotionGate || runPromotionGate)(options, deps);
  const promotionReady = Boolean(report && report.summary && report.summary.promotionReady);
  const reportOk = Boolean(report && report.ok !== false);
  return {
    ...report,
    transportConfig: merged.source,
    json: options.json === true,
    exitOk: reportOk && (options.failOnBlocked === true ? promotionReady : true)
  };
}

function formatFabricTransportPromotionGateReport(report = {}) {
  return formatReport(report);
}

module.exports = {
  formatFabricTransportPromotionGateReport,
  runFabricTransportPromotionGateCommand
};
