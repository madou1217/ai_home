'use strict';

// 跨语言对拍（制品层）：同一批 .aih-plugin 分别跑 Node inspectArtifact 与 Go
// inspectArtifact，accept/reject 与错误码必须一致。覆盖合法签名、未签名、
// 信任根缺失、签名字节被篡改、包内容被篡改、requireSigned、坏魔数与非法路径。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildArtifact, inspectArtifact } = require('../lib/plugins/control/artifact');
const { addTrustedKey } = require('../lib/plugins/control/signature');

const REPO_ROOT = path.resolve(__dirname, '..');
const OPTIONS = { hostVersion: '1.0.0', nodeVersion: '22.14.0', target: 'darwin-arm64' };

function newKey() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

function writeSource(directory, pluginId) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    protocolVersion: 1,
    pluginId,
    version: '1.0.0',
    engines: { aih: '>=1.0.0', node: '>=22' },
    runtime: 'node',
    entry: 'index.mjs',
    targets: ['any'],
    contributes: [{ id: pluginId + '.run', capability: 'command', version: 1 }]
  };
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'index.mjs'), 'export default {};\n');
  return manifest;
}

function rewriteMetadata(buffer, mutate) {
  const metadataLength = buffer.readUInt32BE(8);
  const metadata = JSON.parse(buffer.subarray(12, 12 + metadataLength).toString('utf8'));
  mutate(metadata);
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8');
  const header = Buffer.alloc(12);
  buffer.copy(header, 0, 0, 8);
  header.writeUInt32BE(encoded.length, 8);
  return Buffer.concat([header, encoded, buffer.subarray(12 + metadataLength)]);
}

function buildRawPackage(manifest, entries) {
  const records = entries.map((entry) => ({
    path: entry.path,
    size: Buffer.byteLength(entry.content),
    sha256: crypto.createHash('sha256').update(entry.content).digest('hex')
  }));
  const metadata = Buffer.from(JSON.stringify({ formatVersion: 1, manifest, files: records }), 'utf8');
  const header = Buffer.alloc(12);
  header.write('AIHPLG01', 0, 'ascii');
  header.writeUInt32BE(metadata.length, 8);
  return Buffer.concat([header, metadata, ...entries.map((entry) => Buffer.from(entry.content, 'utf8'))]);
}

function runNodeInspect(file, requireSigned, home) {
  try {
    inspectArtifact(file, { ...OPTIONS, aiHomeDir: home, requireSigned });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error && error.code ? String(error.code) : 'plugin_error' };
  }
}

test('Node 与 Go 的制品校验 accept/reject 与错误码一致', { timeout: 120000 }, (t) => {
  if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('本机没有 go 工具链');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-artifact-parity-'));
  t.after(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_error) {} });
  const home = path.join(directory, 'home');
  fs.mkdirSync(home, { recursive: true });
  const trusted = newKey();
  const untrusted = newKey();
  addTrustedKey(home, { publicKey: trusted.publicKey, keyId: 'trusted-key' });

  const source = path.join(directory, 'source');
  const manifest = writeSource(source, 'aih.parity.artifact');
  const signedFile = path.join(directory, 'signed.aih-plugin');
  buildArtifact(source, signedFile, { signingKey: trusted.privateKey, keyId: 'trusted-key' });
  const unsignedFile = path.join(directory, 'unsigned.aih-plugin');
  buildArtifact(source, unsignedFile, {});
  const untrustedFile = path.join(directory, 'untrusted.aih-plugin');
  buildArtifact(source, untrustedFile, { signingKey: untrusted.privateKey, keyId: 'untrusted-key' });

  const signedBytes = fs.readFileSync(signedFile);
  const tamperedContent = path.join(directory, 'tampered-content.aih-plugin');
  const tampered = Buffer.from(signedBytes);
  tampered[tampered.length - 1] ^= 0xff;
  fs.writeFileSync(tamperedContent, tampered);
  const badSignature = path.join(directory, 'bad-signature.aih-plugin');
  fs.writeFileSync(badSignature, rewriteMetadata(signedBytes, (metadata) => { metadata.manifest.version = '1.0.1'; }));
  const badAlgorithm = path.join(directory, 'bad-algorithm.aih-plugin');
  fs.writeFileSync(badAlgorithm, rewriteMetadata(signedBytes, (metadata) => { metadata.signature.algorithm = 'rsa'; }));
  const badMagic = path.join(directory, 'bad-magic.aih-plugin');
  const magicBytes = Buffer.from(signedBytes);
  magicBytes[0] = 0x58;
  fs.writeFileSync(badMagic, magicBytes);
  const unsafePath = path.join(directory, 'unsafe-path.aih-plugin');
  fs.writeFileSync(unsafePath, buildRawPackage(manifest, [
    { path: 'index.mjs', content: 'export default {};\n' },
    { path: '../evil.js', content: 'bad\n' }
  ]));

  const cases = [
    { name: '合法签名', file: signedFile, requireSigned: false },
    { name: '合法签名 + requireSigned', file: signedFile, requireSigned: true },
    { name: '未签名', file: unsignedFile, requireSigned: false },
    { name: '未签名 + requireSigned', file: unsignedFile, requireSigned: true },
    { name: '公钥不在信任根', file: untrustedFile, requireSigned: false },
    { name: '包内容被篡改', file: tamperedContent, requireSigned: false },
    { name: '签名与内容不匹配', file: badSignature, requireSigned: false },
    { name: '签名算法不支持', file: badAlgorithm, requireSigned: false },
    { name: '魔数错误', file: badMagic, requireSigned: false },
    { name: '包内路径非法', file: unsafePath, requireSigned: false }
  ];

  const binary = path.join(directory, 'artifactvalidator');
  const build = spawnSync('go', ['build', '-o', binary, './testdata/artifactvalidator'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  assert.equal(build.status, 0, build.stderr || 'go build 失败');
  const input = cases.map((item) => JSON.stringify({
    file: item.file,
    aiHomeDir: home,
    requireSigned: item.requireSigned,
    ...OPTIONS
  })).join('\n');
  const execution = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 60000 });
  assert.equal(execution.status, 0, execution.stderr || 'Go 校验器失败');
  const goResults = execution.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(goResults.length, cases.length);

  for (let index = 0; index < cases.length; index += 1) {
    const nodeResult = runNodeInspect(cases[index].file, cases[index].requireSigned, home);
    const goResult = goResults[index];
    assert.equal(goResult.ok, nodeResult.ok, cases[index].name + ' 的 accept/reject 结论不一致');
    if (!nodeResult.ok) {
      assert.equal(goResult.code, nodeResult.code, cases[index].name + ' 的错误码不一致（Go=' + goResult.code + ' Node=' + nodeResult.code + '）');
    }
  }
});
