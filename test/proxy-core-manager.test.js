'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');

const {
  chooseLoopbackPort,
  discoverMihomoCore,
  executeMihomoInstall,
  planMihomoInstall,
  removeManagedMihomo
} = require('../lib/cli/services/toolkit/proxy-pool/mihomo-core-manager');

function response(body, statusCode = 200) {
  return {
    statusCode,
    body: {
      async text() { return body; },
      async arrayBuffer() { return Buffer.from(body); }
    }
  };
}

test('discoverMihomoCore reuses a known Clash Verge binary without claiming ownership', () => {
  const binary = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo';
  const result = discoverMihomoCore({
    platform: 'darwin',
    env: { PATH: '' },
    fs: {
      existsSync(target) { return target === binary; },
      statSync() { return { isFile: () => true }; },
      accessSync() {}
    },
    spawnSync(command) {
      assert.equal(command, binary);
      return { status: 0, stdout: 'Mihomo Meta v1.19.29\n', stderr: '' };
    }
  });

  assert.equal(result.installed, true);
  assert.equal(result.source, 'known-app');
  assert.equal(result.managed, false);
  assert.equal(result.version, '1.19.29');
  assert.equal(result.reusable, true);
});

test('chooseLoopbackPort keeps the preferred port when it is free and skips foreign listeners', async () => {
  const occupied = new Set([10800, 10801]);
  const result = await chooseLoopbackPort(10800, {
    minPort: 10800,
    maxPort: 10804,
    isPortAvailable: async (port) => !occupied.has(port)
  });
  assert.equal(result.port, 10802);
  assert.equal(result.requestedPort, 10800);
  assert.equal(result.reused, false);
  assert.equal(result.reason, 'preferred_port_in_use');
});

test('planMihomoInstall selects a signed official asset and binds the plan to its digest', async () => {
  const metadata = {
    tag_name: 'v1.19.29',
    prerelease: false,
    draft: false,
    assets: [{
      name: 'mihomo-darwin-arm64-v1.19.29.gz',
      browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-darwin-arm64-v1.19.29.gz',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 42
    }]
  };
  const plan = await planMihomoInstall({ platform: 'darwin', arch: 'arm64' }, {
    requestImpl: async (url) => {
      assert.equal(url, 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest');
      return response(JSON.stringify(metadata));
    },
    aiHomeDir: '/tmp/aih-test-home'
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.plan.version, '1.19.29');
  assert.equal(plan.plan.digest, 'a'.repeat(64));
  assert.equal(plan.plan.official, true);
  assert.match(plan.plan.planId, /^[a-f0-9]{64}$/);
});

test('planMihomoInstall normalizes win32 to the official Windows zip asset', async () => {
  const metadata = {
    tag_name: 'v1.19.29',
    prerelease: false,
    draft: false,
    assets: [{
      name: 'mihomo-windows-amd64-v1.19.29.zip',
      browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-windows-amd64-v1.19.29.zip',
      digest: `sha256:${'b'.repeat(64)}`,
      size: 42
    }]
  };
  const plan = await planMihomoInstall({ platform: 'win32', arch: 'x64' }, {
    requestImpl: async () => response(JSON.stringify(metadata)),
    aiHomeDir: '/tmp/aih-test-home-win'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.platform, 'windows');
  assert.equal(plan.plan.archiveFormat, 'zip');
  assert.match(plan.plan.targetPath, /mihomo\.exe$/);
});

test('discoverMihomoCore probes the managed Windows executable with its platform suffix', () => {
  const home = '/tmp/aih-managed-win';
  const target = path.join(home, 'tools', 'mihomo', 'current', 'mihomo.exe');
  const result = discoverMihomoCore({
    platform: 'win32',
    aiHomeDir: home,
    env: { PATH: '', USERPROFILE: 'C:\\Users\\tester', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    fs: {
      existsSync(candidate) { return candidate === target; },
      statSync(candidate) {
        assert.equal(candidate, target);
        return { isFile: () => true };
      },
      accessSync() {}
    },
    spawnSync(command) {
      assert.equal(command, target);
      return { status: 0, stdout: 'Mihomo Meta v1.19.29\\n', stderr: '' };
    }
  });

  assert.equal(result.installed, true);
  assert.equal(result.source, 'managed');
  assert.equal(result.binaryPath, target);
});

test('executeMihomoInstall verifies the release digest before publishing the managed binary', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-core-manager-'));
  const archive = Buffer.from('mihomo-test-binary');
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const plan = {
    version: '1.0.0',
    digest,
    assetName: 'mihomo-darwin-arm64-v1.0.0.gz',
    downloadUrl: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.0.0/mihomo-darwin-arm64-v1.0.0.gz',
    planId: crypto.createHash('sha256').update(`1.0.0\0${digest}\0${tempHome}`).digest('hex'),
    targetDir: path.join(tempHome, 'tools', 'mihomo', '1.0.0'),
    targetPath: path.join(tempHome, 'tools', 'mihomo', '1.0.0', 'mihomo'),
    archiveFormat: 'raw-test',
    official: true,
    managed: true
  };
  try {
    const result = await executeMihomoInstall(plan, {
      confirmed: true,
      aiHomeDir: tempHome,
      requestImpl: async () => response(archive),
      extractArchive: async (content, targetPath) => fs.writeFileSync(targetPath, content),
      verifyBinary: () => true
    });
    assert.equal(result.ok, true);
    assert.equal(result.managed, true);
    assert.equal(fs.readFileSync(plan.targetPath, 'utf8'), archive.toString());
    assert.equal((fs.statSync(plan.targetPath).mode & 0o777), 0o700);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('executeMihomoInstall refuses a changed confirmation plan and never downloads', async () => {
  let requests = 0;
  const result = await executeMihomoInstall({
    version: '1.0.0',
    digest: 'b'.repeat(64),
    planId: 'wrong'
  }, {
    confirmed: true,
    requestImpl: async () => { requests += 1; return response(''); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'install_plan_invalid');
  assert.equal(requests, 0);
});

test('removeManagedMihomo only removes AIH-owned files after explicit confirmation', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-core-remove-'));
  const managedDir = path.join(tempHome, 'tools', 'mihomo');
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(path.join(managedDir, 'current.json'), '{}');
  try {
    assert.deepEqual(removeManagedMihomo({ aiHomeDir: tempHome }), {
      ok: false,
      error: 'confirmation_required'
    });
    const result = removeManagedMihomo({ aiHomeDir: tempHome, confirmed: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(managedDir), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
