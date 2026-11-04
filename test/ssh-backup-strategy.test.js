'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSshBackupStrategy,
  expandHome,
  resolveRemoteDir
} = require('../lib/account/backup/strategies/ssh');

function createFakeSftp(files) {
  const directories = new Set(['/home/ubuntu']);
  return {
    realpath(_target, callback) {
      callback(null, '/home/ubuntu');
    },
    mkdir(remotePath, callback) {
      if (directories.has(remotePath) || files.has(remotePath)) {
        callback(Object.assign(new Error('exists'), { code: 4 }));
        return;
      }
      directories.add(remotePath);
      callback(null);
    },
    stat(remotePath, callback) {
      if (directories.has(remotePath)) {
        callback(null, { isDirectory: () => true, size: 0, mtime: 1 });
        return;
      }
      if (files.has(remotePath)) {
        callback(null, { isDirectory: () => false, size: files.get(remotePath).length, mtime: 1 });
        return;
      }
      callback(Object.assign(new Error('missing'), { code: 2 }));
    },
    readFile(remotePath, callback) {
      if (files.has(remotePath)) callback(null, Buffer.from(files.get(remotePath)));
      else callback(Object.assign(new Error('missing'), { code: 2 }));
    },
    writeFile(remotePath, data, _options, callback) {
      files.set(remotePath, String(data));
      callback(null);
    },
    rename(from, to, callback) {
      if (!files.has(from)) {
        callback(Object.assign(new Error('missing'), { code: 2 }));
        return;
      }
      files.set(to, files.get(from));
      files.delete(from);
      callback(null);
    },
    unlink(remotePath, callback) {
      if (!files.has(remotePath)) {
        callback(Object.assign(new Error('missing'), { code: 2 }));
        return;
      }
      files.delete(remotePath);
      callback(null);
    }
  };
}

function createFakeClient(files, fingerprint = 'a'.repeat(64)) {
  return class FakeClient {
    constructor() {
      this.handlers = {};
      this.sftpImpl = createFakeSftp(files);
    }

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    connect(config) {
      this.config = config;
      const accepted = typeof config.hostVerifier === 'function' ? config.hostVerifier(fingerprint) : true;
      queueMicrotask(() => {
        if (!accepted) {
          this.handlers.error(new Error('host_verification_failed'));
          return;
        }
        this.handlers.ready();
      });
    }

    sftp(callback) {
      callback(null, this.sftpImpl);
    }

    end() {
      this.ended = true;
    }
  };
}

test('ssh strategy resolves ~ against the remote home and records the fingerprint', async () => {
  const files = new Map();
  const fingerprints = [];
  const strategy = createSshBackupStrategy({
    id: 't1',
    strategy: 'ssh',
    host: 'example.test',
    port: 22,
    username: 'ubuntu',
    remoteDir: '~/.aih-backup',
    identityFile: '',
    passwordEnv: ''
  }, {
    Client: createFakeClient(files),
    env: {},
    onHostKey: (fingerprint) => fingerprints.push(fingerprint)
  });
  // 没有私钥/密码时 buildConnectConfig 会失败。
  await assert.rejects(() => strategy.connect(), /没有可用凭据/);

  const strategyWithPassword = createSshBackupStrategy({
    id: 't2',
    strategy: 'ssh',
    host: 'example.test',
    port: 22,
    username: 'ubuntu',
    remoteDir: '~/.aih-backup',
    identityFile: '',
    passwordEnv: 'TEST_SSH_PASSWORD'
  }, {
    Client: createFakeClient(files),
    env: { TEST_SSH_PASSWORD: 'secret' },
    onHostKey: (fingerprint) => fingerprints.push(fingerprint)
  });
  await strategyWithPassword.connect();
  assert.equal(strategyWithPassword.baseDir, '/home/ubuntu/.aih-backup');
  assert.deepEqual(fingerprints, ['a'.repeat(64)]);
  strategyWithPassword.close();
});

test('ssh strategy writes via a temp file and reads missing files as null', async () => {
  const files = new Map();
  const strategy = createSshBackupStrategy({
    id: 't1',
    strategy: 'ssh',
    host: 'example.test',
    port: 22,
    username: 'ubuntu',
    remoteDir: '/srv/aih-backup',
    identityFile: '',
    passwordEnv: 'TEST_SSH_PASSWORD'
  }, {
    Client: createFakeClient(files),
    env: { TEST_SSH_PASSWORD: 'secret' }
  });
  assert.equal(await strategy.readFile('manifest.json'), null);
  await strategy.writeFile('accounts/codex/acct_aaaaaaaaaaaaaaaaaaaa.json', '{"ok":true}');
  assert.equal(files.get('/srv/aih-backup/accounts/codex/acct_aaaaaaaaaaaaaaaaaaaa.json'), '{"ok":true}');
  assert.equal([...files.keys()].some((key) => key.includes('.tmp-')), false);
  assert.equal(await strategy.readFile('accounts/codex/acct_aaaaaaaaaaaaaaaaaaaa.json'), '{"ok":true}');
  strategy.close();
});

test('ssh strategy rejects a configured fingerprint mismatch', async () => {
  const files = new Map();
  const strategy = createSshBackupStrategy({
    id: 't1',
    strategy: 'ssh',
    host: 'example.test',
    port: 22,
    username: 'ubuntu',
    remoteDir: '~/.aih-backup',
    identityFile: '',
    passwordEnv: 'TEST_SSH_PASSWORD',
    hostKeyFingerprint: 'b'.repeat(64)
  }, {
    Client: createFakeClient(files, 'c'.repeat(64)),
    env: { TEST_SSH_PASSWORD: 'secret' }
  });
  await assert.rejects(() => strategy.connect(), /host_verification_failed/);
});

test('path helpers keep ~ and relative directories inside the remote home', () => {
  assert.equal(resolveRemoteDir('~', '/home/u'), '/home/u');
  assert.equal(resolveRemoteDir('~/backup', '/home/u'), '/home/u/backup');
  assert.equal(resolveRemoteDir('/srv/backup', '/home/u'), '/srv/backup');
  assert.equal(resolveRemoteDir('C:/backup', 'C:/Users/u'), 'C:/backup');
  assert.equal(resolveRemoteDir('backup', '/home/u'), '/home/u/backup');
  assert.match(expandHome('~/.ssh/id_ed25519'), /\.ssh\/id_ed25519$/);
});
