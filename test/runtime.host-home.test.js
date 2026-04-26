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

test('resolveHostHomeDir normalizes nested .ai_home profile HOME to host HOME', () => {
  const out = resolveHostHomeDir({
    env: {
      HOME: '/Users/model/.ai_home/profiles/codex/1888'
    },
    platform: 'darwin',
    os: { userInfo: () => ({ homedir: '/Users/fallback' }), homedir: () => '/Users/os-home' }
  });
  assert.equal(out, '/Users/model');
});

test('resolveHostHomeDir normalizes nested .ai_home profile USERPROFILE on win32', () => {
  const out = resolveHostHomeDir({
    env: {
      USERPROFILE: 'C:\\Users\\alice\\.ai_home\\profiles\\codex\\2'
    },
    platform: 'win32',
    os: { userInfo: () => ({ homedir: 'C:\\Users\\fallback' }), homedir: () => 'C:\\Users\\os-home' }
  });
  assert.equal(out, 'C:/Users/alice');
});
