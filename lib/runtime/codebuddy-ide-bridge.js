'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { readAccountCredentialRecord } = require('../server/account-credential-store');
const { inspectCodebuddyCredential } = require('../account/codebuddy-credential-source');
const { resolveAccountRuntimeDir } = require('./aih-storage-layout');
const { bridgeError, readPrivateJson, writePrivateJson, ensurePrivateDirectory } = require('./codebuddy-ide-bridge-files');

const EXTENSION_ID = 'ai-home.aih-native-session-bridge';
const SOURCES = ['codebuddy-ide-bridge-extension.cjs', 'codebuddy-ide-bridge-files.js', 'native-session-bridge-files.js'];

function resolveCodebuddyIdeBridgeBinding(options) {
  const provider = String(options.provider || '');
  if (!['codebuddy', 'codebuddycn'].includes(provider)) return null;
  const record = readAccountCredentialRecord(fs, options.aiHomeDir, options.accountRef);
  if (!record || record.provider !== provider) return null;
  const identity = inspectCodebuddyCredential(record.nativeAuth?.credentials, provider);
  if (!identity.ok || !/^[A-Za-z0-9_-]+$/.test(identity.uid)) return null;
  const profileDir = resolveAccountRuntimeDir(options.aiHomeDir, provider, options.accountRef);
  if (options.profileDir && path.resolve(options.profileDir) !== profileDir
    || fs.realpathSync(profileDir) !== profileDir) throw bridgeError('codebuddy_ide_profile_mismatch');
  const platform = options.platform || process.platform;
  const parts = platform === 'darwin' ? ['Library', 'Application Support']
    : platform === 'win32' ? ['AppData', 'Local'] : ['.local', 'share'];
  const historyRoot = path.join(profileDir, ...parts, 'CodeBuddyExtension', 'Data',
    identity.uid, 'CodeBuddyIDE', identity.uid, 'history');
  const hash = crypto.createHash('sha256');
  for (const name of SOURCES) hash.update(fs.readFileSync(path.join(__dirname, name)));
  return { version: `0.1.0-h${hash.digest('hex').slice(0, 12)}`, provider,
    accountRef: options.accountRef, userId: identity.uid, profileDir, historyRoot,
    mailboxDir: path.join(profileDir, '.aih-runtime', 'codebuddy-ide-bridge') };
}

function prepareCodebuddyIdeBridge(options) {
  const binding = resolveCodebuddyIdeBridgeBinding(options);
  if (!binding) return { ready: true, supported: false };
  // The two official IDEs use different dataFolderName values. Read the actual
  // installed product rather than deriving this directory from the CLI name.
  const productFile = options.bundlePath
    ? path.join(options.bundlePath, 'Contents', 'Resources', 'app', 'product.json')
    : path.join(path.dirname(options.executablePath || ''), 'resources', 'app', 'product.json');
  const product = readPrivateJson(productFile);
  if (!/^\.[A-Za-z0-9_-]+$/.test(product?.dataFolderName || '')) {
    throw bridgeError('codebuddy_ide_product_metadata_missing');
  }
  const extensionsDir = path.join(binding.profileDir, product.dataFolderName, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(extensionsDir) !== extensionsDir) throw bridgeError('codebuddy_ide_extensions_not_private');
  const name = `${EXTENSION_ID}-${binding.version}`;
  const extensionPath = path.join(extensionsDir, name);
  ensurePrivateDirectory(extensionPath);
  ensurePrivateDirectory(binding.mailboxDir);
  for (const part of ['hosts', 'requests', 'results']) ensurePrivateDirectory(path.join(binding.mailboxDir, part));
  for (const source of SOURCES) fs.writeFileSync(path.join(extensionPath, source), fs.readFileSync(path.join(__dirname, source)), { mode: 0o600 });
  writePrivateJson(path.join(extensionPath, 'binding.json'), binding);
  writePrivateJson(path.join(extensionPath, 'package.json'), {
    name: 'aih-native-session-bridge', publisher: 'ai-home', version: binding.version,
    engines: { vscode: '^1.90.0' }, main: './codebuddy-ide-bridge-extension.cjs',
    activationEvents: ['onStartupFinished'], extensionDependencies: ['Tencent-Cloud.coding-copilot'],
    extensionKind: ['ui'], capabilities: { untrustedWorkspaces: { supported: false } }
  });
  const manifestFile = path.join(extensionsDir, 'extensions.json');
  const existing = fs.existsSync(manifestFile) ? readPrivateJson(manifestFile) : [];
  if (!Array.isArray(existing)) throw bridgeError('codebuddy_ide_extension_manifest_invalid');
  const uri = pathToFileURL(extensionPath);
  const entry = { identifier: { id: EXTENSION_ID }, version: binding.version,
    location: { $mid: 1, scheme: 'file', path: decodeURIComponent(uri.pathname), fsPath: extensionPath, external: uri.href },
    relativeLocation: name, metadata: { source: 'vsix', targetPlatform: 'undefined' } };
  const rows = existing.filter(row => row.identifier?.id !== EXTENSION_ID);
  rows.push(entry);
  if (JSON.stringify(rows) !== JSON.stringify(existing)) writePrivateJson(manifestFile, rows);
  return { ready: true, supported: true, extensionsDir, extensionPath, binding };
}

module.exports = { EXTENSION_ID, prepareCodebuddyIdeBridge, resolveCodebuddyIdeBridgeBinding };
