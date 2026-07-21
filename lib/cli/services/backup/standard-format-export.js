'use strict';

const {
  buildAntigravityManagerExportPayload,
  buildSub2ApiExportPayload
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

  function exportSub2ApiData(optionsArg = {}) {
    const payload = buildSub2ApiExportPayload({
      fs,
      path,
      aiHomeDir,
      providers: optionsArg.providers
    });
    const outPath = writeJsonExport(optionsArg.outPath, payload);
    return {
      format: 'sub2api',
      outPath,
      accounts: payload.accounts.length,
      proxies: payload.proxies.length
    };
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
    exportSub2ApiData,
    exportAntigravityManagerAccounts
  };
}

module.exports = {
  createStandardFormatExportService
};
