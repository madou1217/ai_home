'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { copyTree, ensureDir, sha256File } = require('./fs-utils');
const { isWindows, targetKey } = require('./targets');
const { verifyBuildStamp, readPackageVersion, computeRouteManifestHash } = require('../../lib/cli/services/server/go-core-build-stamp');

// Both components are required by current CLI ownership. Never publish a
// bundle that silently turns missing compilation into a disabled feature.
function copyNativeComponents(repositoryRoot, bundleRoot, target) {
  const key = targetKey(target);
  const suffix = isWindows(target) ? '.exe' : '';
  const engineNames = ['aih-engine-mihomo', 'aih-engine-singbox', 'aih-render-subscriptions'];
  const names = ['aih-server', 'aih-go', ...engineNames].map((name) => name + suffix);
  const sourceDir = path.join(repositoryRoot, 'bin', 'native', key);
  const files = names.map((name) => {
    const file = path.join(sourceDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`required_native_component_missing:${key}/${name}`);
    return { name, file, sha256: sha256File(file) };
  });
  const stampPath = path.join(sourceDir, `${names[0]}.build.json`);
  if (!fs.existsSync(stampPath)) throw new Error('required_server_build_stamp_missing');
  const verified = verifyBuildStamp(fs, {
    binaryPath: files[0].file,
    expectedVersion: readPackageVersion(fs, repositoryRoot),
    expectedRouteManifestHash: computeRouteManifestHash(fs, repositoryRoot)
  });
  if (!verified.ok || verified.stamp.target !== key) throw new Error(`native_server_build_stamp_mismatch:${verified.code || 'target'}`);
  const destination = path.join(bundleRoot, 'bin', 'native', key);
  ensureDir(destination);
  for (const item of files) {
    copyTree(item.file, path.join(destination, item.name), { dereference: true });
    if (!isWindows(target)) fs.chmodSync(path.join(destination, item.name), 0o755);
  }
  copyTree(stampPath, path.join(destination, `${names[0]}.build.json`));
  return {
    binary: `bin/native/${key}/${names[0]}`,
    sha256: files[0].sha256,
    cli: { binary: `bin/native/${key}/${names[1]}`, sha256: files[1].sha256 },
    engines: files.slice(2).map((file) => ({
      binary: `bin/native/${key}/${file.name}`,
      sha256: file.sha256
    }))
  };
}

module.exports = { copyNativeComponents };
