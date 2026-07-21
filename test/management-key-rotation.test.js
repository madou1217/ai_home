const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReplacementManagementKey,
  createManagementKeyRotationService
} = require('../lib/server/management-key-rotation');

function remoteRequest(managementKey = '') {
  return {
    socket: { remoteAddress: '192.0.2.10' },
    headers: managementKey
      ? { authorization: `Bearer ${managementKey}` }
      : {}
  };
}

test('management key rotation requires the current Bearer even on loopback', () => {
  const service = createManagementKeyRotationService({
    initialManagementKey: 'old-management-key-that-is-long-enough',
    managementKeySource: 'server-config',
    writeServerConfig: (patch) => patch
  });

  assert.throws(() => service.rotate({
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    managementKey: 'new-management-key-that-is-long-enough'
  }), (error) => error && error.code === 'webui_unauthorized' && error.statusCode === 401);
});

test('management key rotation persists and hot-swaps one canonical key', () => {
  const writes = [];
  const oldKey = 'old-management-key-that-is-long-enough';
  const newKey = 'new-management-key-that-is-long-enough';
  const newerKey = 'newer-management-key-that-is-long-enough';
  const service = createManagementKeyRotationService({
    initialManagementKey: oldKey,
    managementKeySource: 'server-config',
    writeServerConfig: (patch) => {
      writes.push(patch);
      return { managementKey: patch.managementKey };
    }
  });

  const result = service.rotate({ req: remoteRequest(oldKey), managementKey: newKey });
  assert.equal(result.managementKeyConfigured, true);
  assert.equal(Number.isFinite(result.rotatedAt), true);
  assert.equal(service.getRequiredManagementKey(), newKey);
  assert.deepEqual(writes, [{ managementKey: newKey }]);

  assert.throws(() => service.rotate({
    req: remoteRequest(oldKey),
    managementKey: newerKey
  }), (error) => error && error.code === 'webui_unauthorized');
  assert.doesNotThrow(() => service.rotate({
    req: remoteRequest(newKey),
    managementKey: newerKey
  }));
});

test('management key rotation keeps the runtime key when persistence fails', () => {
  const oldKey = 'old-management-key-that-is-long-enough';
  const service = createManagementKeyRotationService({
    initialManagementKey: oldKey,
    managementKeySource: 'server-config',
    writeServerConfig: () => {
      throw new Error('disk failure with secret-like details');
    }
  });

  assert.throws(() => service.rotate({
    req: remoteRequest(oldKey),
    managementKey: 'new-management-key-that-is-long-enough'
  }), (error) => (
    error
    && error.code === 'management_key_rotation_persist_failed'
    && !error.message.includes('secret-like')
  ));
  assert.equal(service.getRequiredManagementKey(), oldKey);
});

test('management key rotation rejects weak, unchanged, and externally managed replacements', () => {
  assert.throws(
    () => normalizeReplacementManagementKey('short'),
    (error) => error && error.code === 'invalid_management_key'
  );

  const oldKey = 'old-management-key-that-is-long-enough';
  const service = createManagementKeyRotationService({
    initialManagementKey: oldKey,
    managementKeySource: 'server-config',
    writeServerConfig: (patch) => patch
  });
  assert.throws(() => service.rotate({
    req: remoteRequest(oldKey),
    managementKey: oldKey
  }), (error) => error && error.code === 'management_key_unchanged' && error.statusCode === 409);

  const external = createManagementKeyRotationService({
    initialManagementKey: oldKey,
    managementKeySource: 'env:AIH_SERVER_MANAGEMENT_KEY',
    writeServerConfig: (patch) => patch
  });
  assert.throws(() => external.rotate({
    req: remoteRequest(oldKey),
    managementKey: 'new-management-key-that-is-long-enough'
  }), (error) => error && error.code === 'management_key_external_source' && error.statusCode === 409);
});
