const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAccountImporter,
  listImporterSupportedAiClis
} = require('../lib/cli/services/ai-cli/importers');

test('importer registry resolves codex and rejects unsupported providers', () => {
  const supported = listImporterSupportedAiClis();
  assert.equal(Array.isArray(supported), true);
  assert.equal(supported.includes('codex'), true);
  assert.equal(resolveAccountImporter('codex') instanceof Function, true);
  assert.equal(resolveAccountImporter('gemini'), null);
  assert.equal(resolveAccountImporter('claude'), null);
});
