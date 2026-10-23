'use strict';

const {
  buildAntigravityManagerExportPayload
} = require('../../../account/standard-transfer');

function createStandardFormatExportService(options = {}) {
  const {
    fs,
    path,
    aiHomeDir
  } = options;

  function writeJsonExport(outPath, payload) {
    const resolved = path.resolve(String(outPath || ''));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return resolved;
  }

  function exportAntigravityManagerAccounts(optionsArg = {}) {
    const payload = buildAntigravityManagerExportPayload({
      fs,
      path,
      aiHomeDir,
      providers: ['agy']
    });
    const outPath = writeJsonExport(optionsArg.outPath, payload);
    return {
      format: 'antigravity',
      outPath,
      accounts: payload.accounts.length
    };
  }

  return {
    exportAntigravityManagerAccounts
  };
}

module.exports = {
  createStandardFormatExportService
};
