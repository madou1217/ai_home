'use strict';

// P4/P5 治理面：账号插件权限声明、包签名/信任根、fail-closed 安装策略与审计记录。
// 价格复核与价格源快照见 plugin-pricing-sync / pricing-catalog-source-store 测试。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildArtifact, acceptArtifact, inspectArtifact } = require('../lib/plugins/control/artifact');
const { addTrustedKey, readTrustedKeys, removeTrustedKey } = require('../lib/plugins/control/signature');
const { validateManifest } = require('../lib/plugins/sdk/manifest');
const { createPluginAuditLog } = require('../lib/plugins/control/audit');

function tempDir(t, prefix = 'aih-plugin-governance-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function accountManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    pluginId: 'aih.test.account',
    version: '0.1.0',
    engines: { aih: '>=1.0.0', node: '>=22' },
    runtime: 'node',
    entry: 'index.mjs',
    targets: ['any'],
    contributes: [
      { id: 'aih.test.account.source', capability: 'account.source', version: 1 }
    ],
    ...overrides
  };
}

function writePlugin(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.mjs'), [
    "import { definePlugin } from '@ai-home/plugin-sdk';",
    'export default definePlugin({',
    "  name: 'aih.test.account',",
    '  apply(ctx) {',
    "    ctx.aih.register('aih.test.account.source', {",
    "      async list() { return { sources: [] }; }",
    '    });',
    '  }',
    '});',
    ''
  ].join('\n'));
}

test('official pricing sample plugins are valid, signed-ready external packages', () => {
  const root = path.join(__dirname, '..', 'examples', 'plugins');
  for (const name of ['pricing-official-openai', 'pricing-official-anthropic', 'pricing-official-google', 'pricing-official-deepseek']) {
    const dir = path.join(root, name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const validated = validateManifest(manifest);
    assert.equal(validated.contributes[0].capability, 'pricing.catalog', name);
    assert.ok(validated.permissions.network.length > 0, name);
    assert.equal(fs.existsSync(path.join(dir, validated.entry)), true, name);
  }
});

test('account plugins must declare permissions explicitly', () => {
  assert.throws(
    () => validateManifest(accountManifest()),
    (error) => error.code === 'plugin_permissions_required'
  );
  const manifest = validateManifest(accountManifest({
    permissions: {
      network: ['https://api.example.com'],
      filesystem: { read: ['state'], write: ['state'] },
      secrets: ['api-token'],
      environment: ['HOME']
    }
  }));
  assert.deepEqual(manifest.permissions.filesystem, { read: ['state'], write: ['state'] });
  assert.deepEqual(manifest.permissions.network, ['https://api.example.com']);
});

test('plugin permissions reject wildcards, credentials in URLs and host filesystem scopes', () => {
  const base = {
    network: ['https://api.example.com'],
    filesystem: { read: ['state'], write: ['state'] },
    secrets: [],
    environment: []
  };
  for (const network of ['*', 'https://*.example.com', 'https://user:pass@example.com', 'http://example.com', 'https://api.example.com/path']) {
    assert.throws(
      () => validateManifest(accountManifest({ permissions: { ...base, network: [network] } })),
      (error) => ['plugin_permission_network_invalid', 'plugin_manifest_invalid'].includes(error.code),
      network
    );
  }
  assert.throws(
    () => validateManifest(accountManifest({
      permissions: { ...base, filesystem: { read: ['home'], write: ['state'] } }
    })),
    (error) => ['plugin_permission_filesystem_invalid', 'plugin_manifest_invalid'].includes(error.code)
  );
});

test('signed packages stay uninstallable until their public key is trusted', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'plugin');
  writePlugin(source, accountManifest({
    permissions: {
      network: ['https://api.example.com'],
      filesystem: { read: ['state'], write: ['state'] },
      secrets: ['api-token'],
      environment: []
    }
  }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const output = path.join(dir, 'account.aih-plugin');
  const built = buildArtifact(source, output, { signingKey: privatePem, keyId: 'test-publisher' });
  assert.equal(built.signature.status, 'signed');
  assert.equal(built.signature.keyId, 'test-publisher');

  const roots = {
    acceptedDir: path.join(dir, 'accepted'),
    extractedDir: path.join(dir, 'extracted')
  };
  assert.throws(
    () => acceptArtifact(output, roots, { hostVersion: '1.0.0', aiHomeDir: path.join(dir, 'home') }),
    (error) => error.code === 'plugin_signature_untrusted'
  );

  const trusted = addTrustedKey(path.join(dir, 'home'), { publicKey: publicPem, keyId: 'test-publisher' });
  assert.equal(trusted.keyId, 'test-publisher');
  assert.equal(readTrustedKeys(path.join(dir, 'home')).has('test-publisher'), true);
  const accepted = acceptArtifact(output, roots, {
    hostVersion: '1.0.0',
    aiHomeDir: path.join(dir, 'home'),
    requireSigned: true
  });
  assert.equal(accepted.signature.status, 'signed');
  assert.equal(accepted.manifest.pluginId, 'aih.test.account');

  const audit = createPluginAuditLog({ aiHomeDir: path.join(dir, 'home') });
  audit.append('trust', { keyId: trusted.keyId });
  assert.equal(audit.read({ limit: 1 })[0].event, 'trust');

  assert.equal(removeTrustedKey(path.join(dir, 'home'), 'test-publisher').removed, true);
  assert.throws(
    () => acceptArtifact(output, roots, { hostVersion: '1.0.0', aiHomeDir: path.join(dir, 'home') }),
    (error) => error.code === 'plugin_signature_untrusted'
  );
});

test('unsigned packages are explicit and requireSigned installs fail closed', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'plugin');
  writePlugin(source, accountManifest({
    permissions: {
      network: [],
      filesystem: { read: [], write: [] },
      secrets: [],
      environment: []
    }
  }));
  const output = path.join(dir, 'account-unsigned.aih-plugin');
  const built = buildArtifact(source, output);
  assert.equal(built.signature.status, 'unsigned');
  const roots = {
    acceptedDir: path.join(dir, 'accepted'),
    extractedDir: path.join(dir, 'extracted')
  };
  const accepted = acceptArtifact(output, roots, { hostVersion: '1.0.0', aiHomeDir: path.join(dir, 'home') });
  assert.equal(accepted.signature.status, 'unsigned');
  assert.throws(
    () => acceptArtifact(output, roots, {
      hostVersion: '1.0.0',
      aiHomeDir: path.join(dir, 'home'),
      requireSigned: true
    }),
    (error) => error.code === 'plugin_signature_required'
  );
});

test('tampering with package content invalidates the file digest', (t) => {
  const dir = tempDir(t);
  const source = path.join(dir, 'plugin');
  writePlugin(source, accountManifest({
    permissions: {
      network: [],
      filesystem: { read: [], write: [] },
      secrets: [],
      environment: []
    }
  }));
  const output = path.join(dir, 'tampered.aih-plugin');
  buildArtifact(source, output);
  const bytes = fs.readFileSync(output);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  fs.writeFileSync(output, bytes);
  assert.throws(
    () => inspectArtifact(output, { hostVersion: '1.0.0', aiHomeDir: path.join(dir, 'home') }),
    (error) => error.code === 'plugin_package_digest_mismatch'
  );
});
