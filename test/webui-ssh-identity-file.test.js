const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { readJsonValue } = require('../lib/server/app-state-store');

function createResponseCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createRouteHarness(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-ssh-key-file-'));
  const aiHomeDir = path.join(rootDir, 'ai-home');
  const homeDir = path.join(rootDir, 'home');
  fs.ensureDirSync(aiHomeDir);
  const sshDir = path.join(homeDir, '.ssh');
  fs.ensureDirSync(sshDir);
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  async function request(method, pathname, body = {}, spawnImpl = null) {
    const res = createResponseCapture();
    const ctx = {
      method,
      pathname,
      req: {},
      res,
      aiHomeDir,
      deps: {
        fs,
        aiHomeDir,
        homeDir,
        spawnImpl,
        writeJson(response, code, payload) {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => Buffer.from(JSON.stringify(body), 'utf8'),
        accountStateIndex: {
          getAccountState() { return null; },
          upsertAccountState() {},
          removeAccount() {}
        },
        getToolAccountIds() { return []; },
        getToolConfigDir() { return '/tmp/config'; },
        getProfileDir() { return '/tmp/profile'; },
        loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
        applyReloadState() {},
        checkStatus() { return { configured: false, accountName: 'Unknown' }; },
        ensureSessionStoreLinks() {}
      }
    };
    const handled = await handleWebUIRequest(ctx);
    return {
      handled,
      statusCode: res.statusCode,
      payload: JSON.parse(res.body)
    };
  }

  return { aiHomeDir, homeDir, sshDir, request };
}

function createMockProcess(stdout = '', status = 0, stderr = '') {
  const processEmitter = new EventEmitter();
  processEmitter.stdout = new EventEmitter();
  processEmitter.stderr = new EventEmitter();
  processEmitter.kill = () => {};
  setTimeout(() => {
    if (stdout) processEmitter.stdout.emit('data', Buffer.from(stdout));
    if (stderr) processEmitter.stderr.emit('data', Buffer.from(stderr));
    processEmitter.emit('close', status);
  }, 5);
  return processEmitter;
}

async function createKeyFileConnection(harness) {
  const response = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'AWS Current Japan',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key-file',
    identityFile: '~/.ssh/aws.pem'
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  return response.payload.connection;
}

test('SSH connection persists a private-key file path without copying key content', async (t) => {
  const harness = createRouteHarness(t);
  fs.writeFileSync(path.join(harness.sshDir, 'aws.pem'), 'test-private-key', { mode: 0o600 });

  const response = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'AWS Current Japan',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key-file',
    identityFile: '~/.ssh/aws.pem'
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.connection.authType, 'key-file');
  assert.equal(response.payload.connection.identityFile, '~/.ssh/aws.pem');
  assert.equal(response.payload.connection.privateKey, '');

  const saved = readJsonValue(fs, harness.aiHomeDir, 'ssh_connections');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].identityFile, '~/.ssh/aws.pem');
  assert.equal(saved[0].privateKey, '');
});

test('SSH connection test expands the saved key path and passes it with -i', async (t) => {
  const harness = createRouteHarness(t);
  const identityFile = path.join(harness.sshDir, 'aws.pem');
  fs.writeFileSync(identityFile, 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-connections/test',
    { connectionId: connection.id, timeoutMs: 3000 },
    (command, args) => {
      assert.equal(command, 'ssh');
      const identityIndex = args.indexOf('-i');
      assert.notEqual(identityIndex, -1);
      assert.equal(args[identityIndex + 1], fs.realpathSync(identityFile));
      assert.equal(args.filter((arg) => arg === '-i').length, 1);
      assert.ok(args.includes('IdentitiesOnly=yes'));
      return createMockProcess([
        'platform=Linux',
        'arch=x86_64',
        'node=present',
        'npm=present',
        'git=present',
        'aih=missing',
        'repo=present',
        ''
      ].join('\n'));
    }
  );

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.result.status, 'reachable');
  assert.equal(response.payload.result.target, 'ubuntu@ec2.example.com');
  assert.equal(response.payload.result.platform, 'Linux');
  assert.ok(response.payload.result.bootstrapAction.remoteRunCommand.includes(`ssh -i ${fs.realpathSync(identityFile)}`));
  assert.match(response.payload.result.bootstrapAction.remoteRunCommand, /-o IdentitiesOnly=yes/);
  assert.match(response.payload.result.recommendation, /-o IdentitiesOnly=yes/);
});

test('SSH connection test ignores stale client auth fields when connectionId is saved', async (t) => {
  const harness = createRouteHarness(t);
  const identityFile = path.join(harness.sshDir, 'aws.pem');
  fs.writeFileSync(identityFile, 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-connections/test',
    {
      connectionId: connection.id,
      host: 'stale.example.com',
      user: 'stale-user',
      authType: 'agent',
      identityFile: '',
      timeoutMs: 3000
    },
    (command, args) => {
      assert.equal(command, 'ssh');
      const identityIndex = args.indexOf('-i');
      assert.notEqual(identityIndex, -1);
      assert.equal(args[identityIndex + 1], fs.realpathSync(identityFile));
      assert.ok(args.includes('ubuntu@ec2.example.com'));
      assert.equal(args.includes('stale-user@stale.example.com'), false);
      return createMockProcess('platform=Linux\narch=x86_64\n');
    }
  );

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.result.status, 'reachable');
  assert.equal(response.payload.result.target, 'ubuntu@ec2.example.com');
});

test('SSH connection test rejects an unknown saved connection', async (t) => {
  const harness = createRouteHarness(t);
  let spawnCalls = 0;

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-connections/test',
    { connectionId: 'conn_missing', timeoutMs: 3000 },
    () => {
      spawnCalls += 1;
      return createMockProcess();
    }
  );

  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.error, 'not_found');
  assert.equal(spawnCalls, 0);
});

test('SSH directory browsing reuses the saved key file without deleting it', async (t) => {
  const harness = createRouteHarness(t);
  const identityFile = path.join(harness.sshDir, 'aws.pem');
  fs.writeFileSync(identityFile, 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-hosts/browse',
    { connectionId: connection.id, subDir: '/srv/app' },
    (command, args) => {
      assert.equal(command, 'ssh');
      const identityIndex = args.indexOf('-i');
      assert.notEqual(identityIndex, -1);
      assert.equal(args[identityIndex + 1], fs.realpathSync(identityFile));
      assert.ok(args.includes('IdentitiesOnly=yes'));
      return createMockProcess('/srv/app\nsrc\n');
    }
  );

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.currentDir, '/srv/app');
  assert.deepEqual(response.payload.directories, [{ name: 'src', path: '/srv/app/src' }]);
  assert.equal(fs.readFileSync(identityFile, 'utf8'), 'test-private-key');
});

test('SSH key-file connections reject paths outside the server user SSH directory', async (t) => {
  const harness = createRouteHarness(t);
  fs.writeFileSync(path.join(harness.homeDir, 'outside.pem'), 'test-private-key', { mode: 0o600 });

  const response = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'Outside Key',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key-file',
    identityFile: '~/.ssh/../outside.pem'
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'invalid_identity_file');
  assert.equal(response.payload.reason, 'identity_file_outside_ssh_dir');
  assert.equal(readJsonValue(fs, harness.aiHomeDir, 'ssh_connections'), null);
});

test('SSH connection test rejects a saved key file that no longer exists before spawning SSH', async (t) => {
  const harness = createRouteHarness(t);
  const identityFile = path.join(harness.sshDir, 'aws.pem');
  fs.writeFileSync(identityFile, 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);
  fs.rmSync(identityFile);
  let spawnCalls = 0;

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-connections/test',
    { connectionId: connection.id, timeoutMs: 3000 },
    () => {
      spawnCalls += 1;
      return createMockProcess();
    }
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'invalid_identity_file');
  assert.equal(response.payload.reason, 'identity_file_not_found');
  assert.equal(spawnCalls, 0);
});

test('SSH directory browsing rejects a saved key file that no longer exists before spawning SSH', async (t) => {
  const harness = createRouteHarness(t);
  const identityFile = path.join(harness.sshDir, 'aws.pem');
  fs.writeFileSync(identityFile, 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);
  fs.rmSync(identityFile);
  let spawnCalls = 0;

  const response = await harness.request(
    'POST',
    '/v0/webui/ssh-hosts/browse',
    { connectionId: connection.id, subDir: '/srv/app' },
    () => {
      spawnCalls += 1;
      return createMockProcess();
    }
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'invalid_identity_file');
  assert.equal(response.payload.reason, 'identity_file_not_found');
  assert.equal(spawnCalls, 0);
});

test('switching a connection to key-file auth removes credentials from the previous strategy', async (t) => {
  const harness = createRouteHarness(t);
  fs.writeFileSync(path.join(harness.sshDir, 'aws.pem'), 'test-private-key', { mode: 0o600 });
  const created = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'Legacy Key',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key',
    privateKey: 'legacy-private-key'
  });
  assert.equal(created.statusCode, 200);

  const updated = await harness.request(
    'PUT',
    `/v0/webui/ssh-connections/${created.payload.connection.id}`,
    {
      authType: 'key-file',
      identityFile: '~/.ssh/aws.pem',
      privateKey: '******'
    }
  );

  assert.equal(updated.statusCode, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.connection.authType, 'key-file');
  assert.equal(updated.payload.connection.identityFile, '~/.ssh/aws.pem');
  assert.equal(updated.payload.connection.privateKey, '');
  const saved = readJsonValue(fs, harness.aiHomeDir, 'ssh_connections');
  assert.equal(saved[0].privateKey, '');
  assert.equal(saved[0].password, '');
});

test('SSH key-file connections reject symlinks that escape the server user SSH directory', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink permissions differ on Windows');
    return;
  }
  const harness = createRouteHarness(t);
  const outsideFile = path.join(harness.homeDir, 'outside.pem');
  fs.writeFileSync(outsideFile, 'test-private-key', { mode: 0o600 });
  fs.symlinkSync(outsideFile, path.join(harness.sshDir, 'aws.pem'));

  const response = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'Symlink Key',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key-file',
    identityFile: '~/.ssh/aws.pem'
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'invalid_identity_file');
  assert.equal(response.payload.reason, 'identity_file_outside_ssh_dir');
});

test('SSH key-file connections reject identity files with group or other permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permissions do not apply on Windows');
    return;
  }
  const harness = createRouteHarness(t);
  fs.writeFileSync(path.join(harness.sshDir, 'aws.pem'), 'test-private-key', { mode: 0o644 });

  const response = await harness.request('POST', '/v0/webui/ssh-connections', {
    label: 'Open Key',
    host: 'ec2.example.com',
    port: 22,
    user: 'ubuntu',
    authType: 'key-file',
    identityFile: '~/.ssh/aws.pem'
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'invalid_identity_file');
  assert.equal(response.payload.reason, 'identity_file_permissions_too_open');
});

test('switching a key-file connection to SSH Agent removes the saved local path', async (t) => {
  const harness = createRouteHarness(t);
  fs.writeFileSync(path.join(harness.sshDir, 'aws.pem'), 'test-private-key', { mode: 0o600 });
  const connection = await createKeyFileConnection(harness);

  const response = await harness.request(
    'PUT',
    `/v0/webui/ssh-connections/${connection.id}`,
    { authType: 'agent' }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.connection.authType, 'agent');
  assert.equal(response.payload.connection.identityFile, '');
  const saved = readJsonValue(fs, harness.aiHomeDir, 'ssh_connections');
  assert.equal(saved[0].identityFile, '');
});
