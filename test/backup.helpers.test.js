const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackupHelperService } = require('../lib/cli/services/backup/helpers');

function createHelper() {
  return createBackupHelperService({
    fs: require('node:fs'),
    path: require('node:path'),
    processObj: { stdout: { write() {} } },
    aiHomeDir: '/tmp/.ai_home',
    cliConfigs: { codex: {}, gemini: {}, claude: {} }
  });
}

test('parseImportArgs supports legacy import syntax', () => {
  const helper = createHelper();
  const parsed = helper.parseImportArgs(['backup.zip']);
  assert.equal(parsed.targetFile, 'backup.zip');
  assert.equal(parsed.provider, '');
  assert.equal(parsed.folder, '');
  assert.equal(parsed.overwrite, false);
});

test('parseImportArgs supports provider and folder hint', () => {
  const helper = createHelper();
  const parsed = helper.parseImportArgs(['codex', 'backup.zip', '-f', 'abc']);
  assert.equal(parsed.targetFile, 'backup.zip');
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.folder, 'abc');
});

test('parseImportArgs supports --from alias', () => {
  const helper = createHelper();
  const parsed = helper.parseImportArgs(['backup.zip', '--from=archive_root']);
  assert.equal(parsed.targetFile, 'backup.zip');
  assert.equal(parsed.provider, '');
  assert.equal(parsed.folder, 'archive_root');
});

test('parseImportArgs rejects unsafe folder hint', () => {
  const helper = createHelper();
  assert.throws(() => helper.parseImportArgs(['backup.zip', '-f', '../abc']), /cannot contain/);
});
