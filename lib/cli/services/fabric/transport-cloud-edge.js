'use strict';

const {
  formatReport,
  parseArgs,
  runCloudEdgePreflight
} = require('../../../../scripts/fabric-cloud-edge-preflight');

async function runFabricTransportCloudEdgeCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : []);
  const report = await (deps.runCloudEdgePreflight || runCloudEdgePreflight)(options, deps);
  const cloudEdgeReady = Boolean(report && report.summary && report.summary.cloudEdgeReady);
  return {
    ...report,
    json: options.json === true,
    exitOk: options.failOnBlocked === true ? cloudEdgeReady : report && report.ok !== false
  };
}

function formatFabricTransportCloudEdgeReport(report = {}) {
  return formatReport(report);
}

module.exports = {
  formatFabricTransportCloudEdgeReport,
  runFabricTransportCloudEdgeCommand
};
