'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseArgs } = require('./lib/cli');
const { describeDigest } = require('./lib/fs-utils');
const {
  BLOB_BYTES,
  FIXTURE_PATHS,
  buildExpectedFixture,
  canonicalPlatform,
  platformKeyringBackend,
  validateApplicationResult,
} = require('./lib/smoke-contract');
const { createFixtureServer } = require('./fixture-server');
const { containsSensitiveMaterial } = require('./collect-release-evidence');
const {
  bootstrapLinuxKeyring,
  parseEnvironmentAssignments,
} = require('./lib/linux-keyring');
const { redactText } = require('./lib/process-utils');
const { validateFixtureRequests } = require('./run-packaged-smoke');
const { validateEvidence } = require('./validate-release-evidence');

function parseSse(payload) {
  return payload.trim().split(/\n\n/u).map((block) => {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    return {
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)),
    };
  });
}

test('fixture enforces Management Key and serves exact JSON/SSE/Blob contracts', async (context) => {
  const managementKey = `test-${crypto.randomBytes(24).toString('hex')}`;
  const runId = crypto.randomUUID();
  const fixture = createFixtureServer({ managementKey, runId });
  const baseUrl = await fixture.listen();
  context.after(() => fixture.close());

  const unauthorized = await fetch(`${baseUrl}${FIXTURE_PATHS.json}`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

  const headers = { Authorization: `Bearer ${managementKey}` };
  const expected = buildExpectedFixture(runId);
  const jsonResponse = await fetch(`${baseUrl}${FIXTURE_PATHS.json}`, { headers });
  assert.equal(jsonResponse.status, 200);
  assert.deepEqual(await jsonResponse.json(), expected.json);

  const sseResponse = await fetch(`${baseUrl}${FIXTURE_PATHS.sse}`, { headers });
  assert.equal(sseResponse.status, 200);
  assert.deepEqual(parseSse(await sseResponse.text()), expected.sse);

  const blobResponse = await fetch(`${baseUrl}${FIXTURE_PATHS.blob}`, { headers });
  assert.equal(blobResponse.status, 200);
  assert.deepEqual(Buffer.from(await blobResponse.arrayBuffer()), BLOB_BYTES);
  assert.equal(blobResponse.headers.get('x-content-sha256'), expected.blob.sha256);

  const snapshot = fixture.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(managementKey), false);
  assert.equal(snapshot.requests.length, 4);
  assert.equal(snapshot.requests.filter((request) => request.authorized).length, 3);
});

test('application result validator requires the platform OS keyring and complete native transports', () => {
  const runId = crypto.randomUUID();
  const expected = buildExpectedFixture(runId);
  const result = {
    schemaVersion: 1,
    runId,
    platform: canonicalPlatform(process.platform),
    keyring: {
      backend: platformKeyringBackend(process.platform),
      stored: true,
      readBack: true,
      deleted: true,
      missingAfterDelete: true,
    },
    http: {
      json: { status: 200, body: expected.json },
      sse: { status: 200, events: expected.sse, completed: true },
      blob: { status: 200, ...expected.blob },
    },
  };

  assert.deepEqual(validateApplicationResult(result, { platform: process.platform, runId }), []);
  result.keyring.backend = 'memory';
  assert.match(
    validateApplicationResult(result, { platform: process.platform, runId }).join('\n'),
    /keyring\.backend/u,
  );
});

test('argument parser preserves command arguments after the sentinel', () => {
  const parsed = parseArgs([
    '--label',
    'build',
    '--required-kind',
    'deb',
    '--required-kind',
    'appimage',
    '--',
    'node',
    'tool.js',
    '--flag',
  ], { repeatable: ['required-kind'] });
  assert.equal(parsed.label, 'build');
  assert.deepEqual(parsed['required-kind'], ['deb', 'appimage']);
  assert.deepEqual(parsed._, ['node', 'tool.js', '--flag']);
});

test('Linux keyring environment parsing and log redaction never expose credentials', () => {
  assert.deepEqual(
    parseEnvironmentAssignments("GNOME_KEYRING_CONTROL='/tmp/keyring'\nSSH_AUTH_SOCK=/tmp/ssh; export SSH_AUTH_SOCK;\n"),
    {
      GNOME_KEYRING_CONTROL: '/tmp/keyring',
      SSH_AUTH_SOCK: '/tmp/ssh',
    },
  );
  const secret = 'desktop-smoke-secret';
  const redacted = redactText(`Authorization: Bearer ${secret}; key=${secret}`, secret);
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /\[REDACTED\]/u);
});

test('Linux keyring bootstrap creates the login collection before starting Secret Service', async () => {
  const calls = [];
  const probeValue = 'aih-keyring-probe-test';
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === '--login') {
      return { stdout: "GNOME_KEYRING_CONTROL='/tmp/aih-keyring'\n" };
    }
    if (args[0] === '--start') {
      return { stdout: 'SSH_AUTH_SOCK=/tmp/aih-keyring/ssh\n' };
    }
    if (args[0] === 'lookup') {
      return { stdout: probeValue };
    }
    return { stdout: '' };
  };

  const environment = await bootstrapLinuxKeyring(
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/aih-dbus' },
    {
      platform: 'linux',
      run,
      createProbeValue: () => probeValue,
    },
  );

  assert.equal(calls[0].options.input, '\n');
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      ['gnome-keyring-daemon', '--login', '--components=secrets'],
      ['gnome-keyring-daemon', '--start', '--components=secrets'],
      [
        'secret-tool',
        'store',
        '--label=AIH Desktop Smoke Bootstrap',
        'application',
        'aih-desktop-smoke-bootstrap',
      ],
      ['secret-tool', 'lookup', 'application', 'aih-desktop-smoke-bootstrap'],
      ['secret-tool', 'clear', 'application', 'aih-desktop-smoke-bootstrap'],
    ],
  );
  assert.equal(calls[1].options.env.GNOME_KEYRING_CONTROL, '/tmp/aih-keyring');
  assert.equal(calls[2].options.input, probeValue);
  assert.equal(environment.GNOME_KEYRING_CONTROL, '/tmp/aih-keyring');
  assert.equal(environment.SSH_AUTH_SOCK, '/tmp/aih-keyring/ssh');
});

test('fixture request ledger rejects missing and unauthorized native requests', () => {
  const requests = [
    { path: FIXTURE_PATHS.json, authorized: true, status: 200 },
    { path: FIXTURE_PATHS.sse, authorized: false, status: 401 },
  ];
  const errors = validateFixtureRequests({ requests });
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /sse/u);
  assert.match(errors.join('\n'), /blob/u);
});

test('release evidence validator recomputes artifact digest and rejects drift', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-evidence-'));
  try {
    const artifactPath = path.join(temporaryRoot, 'AI Home.AppImage');
    fs.writeFileSync(artifactPath, 'artifact-v1');
    const digest = describeDigest(artifactPath);
    const evidence = {
      schemaVersion: 1,
      status: 'passed',
      distributionSigning: { status: 'unsigned', reason: 'test' },
      secretLeakScan: { status: 'passed' },
      requiredArtifacts: ['appimage'],
      artifacts: [{
        kind: 'appimage',
        path: path.basename(artifactPath),
        ...digest,
      }],
      requiredPackagedSmokes: ['appimage'],
      smokes: [{
        status: 'passed',
        bundleKind: 'appimage',
        secretLeakScan: { status: 'passed' },
      }],
      timings: [{ status: 'passed' }],
      installs: [{ status: 'installed' }],
    };
    assert.deepEqual(validateEvidence(evidence, temporaryRoot), []);

    fs.writeFileSync(artifactPath, 'artifact-v2');
    assert.match(validateEvidence(evidence, temporaryRoot).join('\n'), /SHA256/u);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('release evidence secret scan rejects credential-shaped values', () => {
  assert.equal(containsSensitiveMaterial({ status: 'passed' }), false);
  assert.equal(containsSensitiveMaterial({
    secretLeakScan: {
      status: 'pending',
      rule: 'no authorization secrets or Management Key value fields in evidence JSON',
    },
  }), false);
  assert.equal(containsSensitiveMaterial({ authorization: 'Bearer secret-value' }), true);
  assert.equal(containsSensitiveMaterial({ managementKey: 'secret-value' }), true);
  assert.equal(containsSensitiveMaterial({ authorization: 'management-key' }), false);
});

test('desktop workflow covers every required runner and unsigned package matrix without secrets', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  for (const requiredValue of [
    'macos-14',
    'windows-2022',
    'ubuntu-22.04',
    'bundles: app,dmg',
    'bundles: msi',
    'bundles: deb,appimage',
    'PRODUCT_NAME: "AI Home"',
    '--required-smoke-kind dmg',
    '--required-smoke-kind msi',
    '--required-smoke-kind deb',
    '--required-smoke-kind appimage',
    '--signing-status unsigned',
    'actions/upload-artifact@v4',
  ]) {
    assert.equal(workflow.includes(requiredValue), true, `workflow 缺少 ${requiredValue}`);
  }
  assert.equal(workflow.includes('secrets.'), false);
});

test('desktop workflow publishes a guarded GitHub prerelease only after the matrix succeeds', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'desktop-release.yml'),
    'utf8',
  );
  const publishStart = workflow.indexOf('  publish-release:');
  assert.notEqual(publishStart, -1, 'workflow 缺少 publish-release job');
  const publishBlock = workflow.slice(publishStart);
  for (const requiredValue of [
    'needs: build-package-smoke',
    "github.ref == 'refs/heads/main'",
    "needs.build-package-smoke.result == 'success'",
    'actions: read',
    'contents: write',
    'actions/download-artifact@v4',
    'pattern: desktop-*',
    'merge-multiple: false',
    'github-token: ${{ github.token }}',
    'repository: ${{ github.repository }}',
    'run-id: ${{ github.run_id }}',
    'scripts/desktop/prepare-release-assets.js',
    'scripts/desktop/resolve-release-action.js',
    'git/ref/tags/${RELEASE_TAG}',
    'releases?per_page=100',
    '--paginate',
    'gh release create',
    'gh release upload',
    'gh release edit',
    '--clobber',
    '--draft=false',
    '--prerelease',
    '--generate-notes',
  ]) {
    assert.equal(publishBlock.includes(requiredValue), true, `发布 job 缺少 ${requiredValue}`);
  }
  assert.equal(publishBlock.includes('if [[ "$TAG_SHA" != none ]]'), false);
  const buildBlock = workflow.slice(
    workflow.indexOf('  build-package-smoke:'),
    publishStart,
  );
  assert.equal(buildBlock.includes('contents: write'), false);
  assert.equal(buildBlock.includes('name: desktop-${{ matrix.platform }}'), true);
  assert.equal(buildBlock.includes('overwrite: true'), true);
});

test('measured command preserves real success and failure exit evidence', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-timing-'));
  const measureScript = path.resolve(__dirname, 'measure-command.js');
  try {
    for (const expectedExitCode of [0, 7]) {
      const outputPath = path.join(temporaryRoot, `timing-${expectedExitCode}.json`);
      const execution = spawnSync(process.execPath, [
        measureScript,
        '--label',
        `exit-${expectedExitCode}`,
        '--output',
        outputPath,
        '--',
        process.execPath,
        '-e',
        `process.exit(${expectedExitCode})`,
      ], { encoding: 'utf8' });
      assert.equal(execution.status, expectedExitCode);
      const timing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.equal(timing.exitCode, expectedExitCode);
      assert.equal(timing.status, expectedExitCode === 0 ? 'passed' : 'failed');
      assert.equal(Number.isInteger(timing.durationMs), true);
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
