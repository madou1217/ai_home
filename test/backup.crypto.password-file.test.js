const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createBackupCryptoService } = require('../lib/cli/services/backup/crypto');

function createService() {
  return createBackupCryptoService({
    fs,
    path,
    crypto,
    spawnSync: () => ({ status: 1 }),
    execSync: () => {},
    commandExists: () => false,
    askYesNo: () => false,
    processObj: process,
    hostHomeDir: os.homedir(),
    exportMagic: 'AIH_EXPORT_MAGIC:',
    exportVersion: 1,
    ageSshKeyTypes: new Set(['ssh-ed25519', 'ssh-rsa'])
  });
}

test('password archive stream encrypt/decrypt round-trip', async () => {
  const service = createService();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-crypto-test-'));
  const inputPath = path.join(tmpDir, 'in.tar.gz');
  const encryptedPath = path.join(tmpDir, 'out.aes');
  const outputPath = path.join(tmpDir, 'out.tar.gz');

  const payload = Buffer.concat([
    Buffer.from('backup-data-start\n', 'utf8'),
    crypto.randomBytes(128 * 1024),
    Buffer.from('\nbackup-data-end', 'utf8')
  ]);

  try {
    fs.writeFileSync(inputPath, payload);
    await service.encryptTarWithPassword(inputPath, encryptedPath, 'secret-123');
    assert.equal(service.isPasswordArchiveFile(encryptedPath), true);

    await service.decryptPasswordArchive(encryptedPath, outputPath, 'secret-123');
    const restored = fs.readFileSync(outputPath);
    assert.deepEqual(restored, payload);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('password archive decrypt fails on wrong password', async () => {
  const service = createService();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-crypto-test-'));
  const inputPath = path.join(tmpDir, 'in.tar.gz');
  const encryptedPath = path.join(tmpDir, 'out.aes');
  const outputPath = path.join(tmpDir, 'out.tar.gz');

  try {
    fs.writeFileSync(inputPath, crypto.randomBytes(4096));
    await service.encryptTarWithPassword(inputPath, encryptedPath, 'correct-password');

    await assert.rejects(
      service.decryptPasswordArchive(encryptedPath, outputPath, 'wrong-password'),
      /wrong password or corrupted backup/
    );
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
