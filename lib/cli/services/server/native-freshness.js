'use strict';

const { resolveEntryProjectRoot } = require('../../../server/source-fingerprint');
const { verifyBuildStamp, computeRouteManifestHash, readPackageVersion } = require('./go-core-build-stamp');
const { readNativeIdentity } = require('./native-process');

// Node source freshness and the running Go build are separate facts. A healthy
// Node child cannot certify the Go parent or a replacement binary on disk.
function nativeBuildFreshness(pid, options) {
  const identity = readNativeIdentity(options);
  if (!identity || identity.pid !== pid || !/^[a-f0-9]{64}$/.test(identity.binarySha256 || '')) {
    return { nativeBuildVerified: false, nativeBuildReason: 'native_runtime_identity_missing' };
  }
  try {
    const root = resolveEntryProjectRoot(options.fs, options.path, options.entryFilePath);
    const check = verifyBuildStamp(options.fs, {
      binaryPath: identity.executable,
      expectedVersion: readPackageVersion(options.fs, root),
      expectedRouteManifestHash: computeRouteManifestHash(options.fs, root)
    });
    if (!check.ok) return { nativeBuildVerified: false, nativeBuildReason: check.code };
    if (check.stamp.binary_sha256 !== identity.binarySha256) {
      return { nativeBuildVerified: false, nativeBuildReason: 'native_running_binary_changed' };
    }
    return { nativeBuildVerified: true, nativeBuildReason: '', nativeBuildStartedAt: identity.startedAt };
  } catch (_error) {
    return { nativeBuildVerified: false, nativeBuildReason: 'go_core_build_unverified' };
  }
}

module.exports = { nativeBuildFreshness };
