'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createServerAutostartService } = require('../lib/cli/services/server/autostart');

test('systemd unit writes WorkingDirectory unquoted; quotes there make the path non-absolute', () => {
  const written = new Map();
  const removed = [];
  const calls = [];
  const oldUnit = '/home/u/.config/systemd/user/com.clawdcodex.ai_home.service';
  written.set(oldUnit, 'old unit');
  const fs = {
    existsSync: (file) => written.has(file),
    writeFileSync: (file, content) => written.set(file, content),
    unlinkSync: (file) => { removed.push(file); written.delete(file); }
  };
  const spawnSync = (command, args) => { calls.push([command, ...(args || [])]); return { status: 0, stdout: '', stderr: '' }; };
  const service = createServerAutostartService({
    fs,
    path,
    spawnSync,
    processObj: {
      platform: 'linux',
      env: { PATH: '/usr/bin', HOME: '/home/u', AIH_CLI_PATH: '/home/u/.local/bin/aih' },
      cwd: () => '/home/u'
    },
    aiHomeDir: '/home/u/.ai_home',
    hostHomeDir: '/home/u',
    ensureDir: () => {},
    resolveStartEntryFilePath: () => ({ entryFilePath: '/opt/aih/lib/cli/entry.js' }),
    resolveStartServeArgs: () => ['--host', '127.0.0.1', '--port', '9527']
  });

  service.install();

  const unitFile = '/home/u/.config/systemd/user/com.meadeo.ai_home.service';
  const unit = written.get(unitFile);
  assert.ok(unit, 'install() should write the systemd unit');
  assert.match(unit, /^WorkingDirectory=\/opt\/aih\/lib\/cli$/m);
  assert.doesNotMatch(unit, /^WorkingDirectory="/m);
  assert.match(unit, /^ExecStart="\/home\/u\/\.local\/bin\/aih" "server" "serve"/m);
  assert.ok(removed.includes(oldUnit), 'install() should delete the legacy clawdcodex unit file');
  assert.ok(
    calls.some((args) => args.join(' ') === 'systemctl --user disable --now com.clawdcodex.ai_home.service'),
    'install() should disable the legacy clawdcodex unit'
  );
});
