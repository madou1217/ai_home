const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveHostHomeDir } = require('../lib/runtime/host-home');

test('resolveHostHomeDir prioritizes AIH_HOST_HOME override', () => {
  const out = resolveHostHomeDir({
    env: {
      AIH_HOST_HOME: '/custom/host-home',
      HOME: '/ignored-home'
    },
    platform: 'linux',
    os: { userInfo: () => ({ homedir: '/ignored-userinfo' }), homedir: () => '/ignored-os' }
  });
  assert.equal(out, '/custom/host-home');
});

test('resolveHostHomeDir normalizes AIH_HOST_HOME that points at .codex', () => {
  const out = resolveHostHomeDir({
    env: {
      AIH_HOST_HOME: 'C:\\Users\\alice\\.codex',
      USERPROFILE: 'C:\\Users\\ignored'
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, 'C:/Users/alice');
});

test('resolveHostHomeDir uses USERPROFILE on win32 when HOME is missing', () => {
  const out = resolveHostHomeDir({
    env: {
      USERPROFILE: 'C:\\Users\\alice'
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, 'C:\\Users\\alice');
});

test('resolveHostHomeDir normalizes .codex USERPROFILE on win32', () => {
  const out = resolveHostHomeDir({
    env: {
      USERPROFILE: 'C:\\Users\\alice\\.codex'
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, 'C:/Users/alice');
});

test('resolveHostHomeDir decodes encoded Windows .codex AIH_HOST_HOME', () => {
  const colon = String.fromCharCode(0xf03a);
  const backslash = String.fromCharCode(0xf05c);
  const out = resolveHostHomeDir({
    env: {
      AIH_HOST_HOME: `C${colon}${backslash}Users${backslash}alice${backslash}.codex`,
      USERPROFILE: 'C:\\Users\\ignored'
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, 'C:/Users/alice');
});

test('resolveHostHomeDir falls back to HOME on non-win32', () => {
  const out = resolveHostHomeDir({
    env: {
      HOME: '/home/alice'
    },
    platform: 'darwin',
    os: { userInfo: () => ({ homedir: '/Users/fallback' }), homedir: () => '/Users/os-home' }
  });
  assert.equal(out, '/home/alice');
});

test('resolveHostHomeDir does not infer host HOME from an account runtime path', () => {
  const runtimeHome = '/Users/model/.ai_home/run/auth-projections/codex/acct_1234567890abcdef1234';
  const out = resolveHostHomeDir({
    env: {
      HOME: runtimeHome
    },
    platform: 'darwin',
    os: { userInfo: () => ({ homedir: '/Users/fallback' }), homedir: () => '/Users/os-home' }
  });
  assert.equal(out, runtimeHome);
});

test('resolveHostHomeDir does not infer host USERPROFILE from an account runtime path', () => {
  const runtimeHome = 'C:\\Users\\alice\\.ai_home\\run\\auth-projections\\codex\\acct_1234567890abcdef1234';
  const out = resolveHostHomeDir({
    env: {
      USERPROFILE: runtimeHome
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, runtimeHome);
});
