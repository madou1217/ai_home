'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRemoteScript, parseRemoteGoTarget } = require('../scripts/deploy-server');

test('remote deploy preflight rejects Go disabled route ownership before restart', () => {
  const script = buildRemoteScript({
    remoteDir: '~/ai_home',
    unit: 'aih-server',
    port: 9527,
    readyTimeoutSec: 5,
    skipGoBuild: true,
    restart: true
  });

  assert.match(script, /go_core\.enabled=false/);
  assert.match(script, /go_core\.routes/);
  assert.match(script, /RUNNING_READYZ/);
  assert.match(script, /SERVICE_ACTIVE/);
  assert.match(script, /running Go Core route ownership/);
  assert.match(script, /go_core disabled but route ownership is non-empty/);
  assert.match(script, /resolveGoOwnedEntryIds/);
  assert.ok(script.indexOf('go_core disabled but route ownership is non-empty') < script.indexOf('rsync -a --delete'));
  assert.ok(script.indexOf('go_core disabled but route ownership is non-empty') < script.indexOf('systemctl --user restart'));
});

test('remote Go target parser rejects unknown platforms instead of guessing', () => {
  assert.deepEqual(parseRemoteGoTarget('Linux x86_64'), { platform: 'linux', arch: 'x64' });
  assert.equal(parseRemoteGoTarget('Plan9 x86_64'), null);
  assert.equal(parseRemoteGoTarget('Linux riscv64'), null);
});
