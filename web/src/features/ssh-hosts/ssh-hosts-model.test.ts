import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SSH_PASSWORD_MASK,
  buildRemotePathCrumbs,
  buildSshConnectionFormValues,
  formatSshTarget
} from './ssh-hosts-model';
import type { SshConnection } from './ssh-hosts-model';

function connection(patch: Partial<SshConnection>): SshConnection {
  return { id: 'c1', label: 'Box', host: '10.0.0.2', port: 22, user: 'root', authType: 'agent', createdAt: 1, ...patch };
}

test('remote path crumbs accumulate absolute paths and mark the last segment', () => {
  assert.deepEqual(buildRemotePathCrumbs('/home/dev/app'), [
    { name: 'home', path: '/home', last: false },
    { name: 'dev', path: '/home/dev', last: false },
    { name: 'app', path: '/home/dev/app', last: true }
  ]);
  assert.deepEqual(buildRemotePathCrumbs('/'), []);
});

test('edit form masks stored secrets only for the matching auth type', () => {
  assert.equal(buildSshConnectionFormValues(connection({ authType: 'password' })).password, SSH_PASSWORD_MASK);
  assert.equal(buildSshConnectionFormValues(connection({ authType: 'password' })).privateKey, '');
  assert.equal(buildSshConnectionFormValues(connection({ authType: 'key' })).privateKey, SSH_PASSWORD_MASK);
  assert.equal(buildSshConnectionFormValues(connection({ authType: 'key-file', identityFile: '~/.ssh/a.pem' })).identityFile, '~/.ssh/a.pem');
  assert.equal(formatSshTarget(connection({ port: 2222 })), 'root@10.0.0.2:2222');
});
