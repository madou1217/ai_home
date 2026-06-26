'use strict';

const { buildNodeBootstrapPlan } = require('../../cli/services/node/bootstrap');
const { buildProbeExecutionPlan } = require('../../cli/services/node/bootstrap-probe');

function cloneReport(report) {
  const source = report && typeof report === 'object' ? report : {};
  return {
    ...source,
    results: Array.isArray(source.results)
      ? source.results.map((result) => ({ ...result }))
      : []
  };
}

function buildProbeBootstrapInput(result, options) {
  const source = options && typeof options === 'object' ? options : {};
  const target = String(result && result.bootstrapTarget || '').trim();
  if (!target) return null;
  return {
    target,
    controlUrl: source.controlUrl,
    inviteUrl: source.inviteUrl,
    endpoint: source.transportKind === 'relay' ? '' : source.endpoint,
    nodeId: result && result.kind === 'ssh' ? '' : source.nodeId,
    repoUrl: source.repoUrl,
    repoDir: source.repoDir,
    repoSubdir: source.repoSubdir,
    transportKind: source.transportKind || 'relay',
    installService: source.installService !== false
  };
}

function buildProbeBootstrapScript(result, options) {
  const input = buildProbeBootstrapInput(result, options);
  if (!input) return null;
  const plan = buildNodeBootstrapPlan(input);
  return {
    target: plan.target,
    type: plan.script.type,
    command: plan.script.command,
    content: plan.script.content,
    requiredInputs: plan.requiredInputs,
    warnings: plan.warnings
  };
}

function buildRemoteBootstrapProbeView(report, options = {}) {
  const nextReport = cloneReport(report);
  nextReport.results = nextReport.results.map((result) => ({
    ...result,
    bootstrapScript: buildProbeBootstrapScript(result, options)
  }));
  nextReport.executionPlan = buildProbeExecutionPlan(nextReport.results);
  return nextReport;
}

module.exports = {
  buildRemoteBootstrapProbeView
};
