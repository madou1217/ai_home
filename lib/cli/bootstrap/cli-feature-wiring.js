'use strict';

const { createCodexBulkImportService } = require('../services/ai-cli/codex-bulk-import');
const { createCodexPolicyService } = require('../services/ai-cli/policy');
const { createCliHelpService } = require('../commands/help/messages');

function createCodexImportWiring(deps = {}, factories = {}) {
  const buildCodexBulkImportService = factories.createCodexBulkImportService || createCodexBulkImportService;
  const codexBulkImportService = buildCodexBulkImportService({
    path: deps.path,
    fs: deps.fs,
    crypto: deps.crypto,
    profilesDir: deps.profilesDir,
    getDefaultParallelism: deps.getDefaultParallelism,
    getToolAccountIds: deps.getToolAccountIds,
    ensureDir: deps.ensureDir,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir
  });
  const { parseCodexBulkImportArgs, importCodexTokensFromOutput } = codexBulkImportService;
  return { parseCodexBulkImportArgs, importCodexTokensFromOutput };
}

function createCodexPolicyWiring(deps = {}, factories = {}) {
  const buildCodexPolicyService = factories.createCodexPolicyService || createCodexPolicyService;
  const codexPolicyService = buildCodexPolicyService({
    aiHomeDir: deps.aiHomeDir,
    loadPermissionPolicy: deps.loadPermissionPolicy,
    savePermissionPolicy: deps.savePermissionPolicy,
    shouldUseDangerFullAccess: deps.shouldUseDangerFullAccess
  });
  const { showCodexPolicy, setCodexPolicy } = codexPolicyService;
  return { showCodexPolicy, setCodexPolicy };
}

function createCliHelpWiring(deps = {}, factories = {}) {
  const buildCliHelpService = factories.createCliHelpService || createCliHelpService;
  const cliHelpService = buildCliHelpService({ log: deps.log });
  const { showHelp, showCliUsage } = cliHelpService;
  return { showHelp, showCliUsage };
}

module.exports = {
  createCodexImportWiring,
  createCodexPolicyWiring,
  createCliHelpWiring
};
