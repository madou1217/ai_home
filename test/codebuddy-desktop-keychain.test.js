'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const { prepareLaunchProfile } = require('../lib/server/desktop-launch/codebuddy-strategy');

function fixture(options = {}) {
  const calls = [], directories = [];
  let projectedKeychain = options.projectedKeychain || '';
  const ctx = {
    platformKey: 'macos', profileDir: '/sandbox/account', hostHomeDir: '/host', path,
    getBaseEnv: () => ({ HOME: '/host', PATH: '/bin' }),
    fs: {
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => Boolean(options.linkedPreferences) }),
      mkdirSync: (directory) => directories.push(directory)
    },
    deps: {
      execFileSync: (file, args, execOptions) => {
        calls.push({ file, args, env: execOptions.env });
        if (args.includes('-s')) {
          if (options.writeFails) throw new Error('security_failed');
          projectedKeychain = args.at(-1);
          return '';
        }
        const keychain = execOptions.env.HOME === '/host'
          ? (options.hostKeychain === undefined ? '/host/Library/Keychains/login.keychain-db' : options.hostKeychain)
          : projectedKeychain;
        if (!keychain) throw new Error('default_keychain_missing');
        return JSON.stringify(keychain);
      }
    }
  };
  return { ctx, calls, directories };
}

test('a missing projected default keychain is prepared without changing host preferences or account HOME', () => {
  const { ctx, calls, directories } = fixture();
  assert.deepEqual(prepareLaunchProfile(ctx), { ready: true });
  const writes = calls.filter(call => call.args.includes('-s'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].env.HOME, '/sandbox/account');
  assert.equal(writes[0].file, '/usr/bin/security');
  assert.deepEqual(writes[0].args, ['default-keychain', '-d', 'user', '-s', '/host/Library/Keychains/login.keychain-db']);
  assert.deepEqual(directories, ['/sandbox/account', '/sandbox/account/Library', '/sandbox/account/Library/Preferences']);
  assert.equal(ctx.getBaseEnv().HOME, '/host');
  prepareLaunchProfile(ctx);
  assert.equal(calls.filter(call => call.args.includes('-s')).length, 1);
});

test('an existing account keychain is preserved and non-macOS platforms do not invoke security', () => {
  const { ctx, calls } = fixture({ projectedKeychain: '/sandbox/account/Library/Keychains/private.keychain-db' });
  assert.deepEqual(prepareLaunchProfile(ctx), { ready: true });
  assert.equal(calls.length, 1);
  for (const platformKey of ['windows', 'linux']) {
    assert.deepEqual(prepareLaunchProfile({ ...ctx, platformKey }), { ready: true });
  }
  assert.equal(calls.length, 1);
});

test('a missing host keychain or a failed reference prevents an unusable desktop launch', () => {
  for (const options of [{ hostKeychain: '' }, { writeFails: true }]) {
    const { ctx } = fixture(options);
    const result = prepareLaunchProfile(ctx);
    assert.equal(result.ready, false);
    assert.equal(result.error, 'codebuddy_desktop_keychain_unavailable');
  }
});

test('linked preferences and a host profile path cannot mutate the real home', () => {
  for (const options of [{ linkedPreferences: true }, {}]) {
    const { ctx, calls } = fixture(options);
    if (!options.linkedPreferences) ctx.profileDir = '/host';
    assert.equal(prepareLaunchProfile(ctx).ready, false);
    assert.equal(calls.some(call => call.args.includes('-s')), false);
  }
});
