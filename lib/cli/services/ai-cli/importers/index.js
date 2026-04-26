'use strict';

const { runCodexImporter } = require('./codex-importer');

const ACCOUNT_IMPORTERS = Object.freeze({
  codex: runCodexImporter
});

function resolveAccountImporter(cliName) {
  return ACCOUNT_IMPORTERS[String(cliName || '').trim()] || null;
}

function listImporterSupportedAiClis() {
  return Object.keys(ACCOUNT_IMPORTERS);
}

module.exports = {
  ACCOUNT_IMPORTERS,
  resolveAccountImporter,
  listImporterSupportedAiClis
};
