'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createServerAutostartService } = require('../lib/cli/services/server/autostart');

function createWindowsHarness({ failVbs = false } = {}) {
  const written = new Map();
  const calls = [];
  const fs = {
    existsSync: (file) => written.has(file),
    writeFileSync: (file, content) => {
      if (failVbs && String(file).toLowerCase().endsWith('.vbs')) {
        const error = new Error(`EPERM: operation not permitted, open '${file}'`);
        error.code = 'EPERM';
        throw error;
      }
      written.set(file, content);
    },
    unlinkSync: (file) => written.delete(file)
  };
  const spawnSync = (command, args) => {
    calls.push([command, ...(args || [])]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const service = createServerAutostartService({
    fs,
    path: path.win32,
    spawnSync,
    processObj: {
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\u',
        USERNAME: 'u',
        PATH: 'C:\\Windows',
        AIH_CLI_PATH: 'C:\\Users\\u\\AppData\\Local\\aih\\aih.exe'
      },
      cwd: () => 'C:\\Users\\u'
    },
    aiHomeDir: 'C:\\Users\\u\\.ai_home',
    hostHomeDir: 'C:\\Users\\u',
    ensureDir: () => {},
    resolveStartEntryFilePath: () => ({ entryFilePath: 'C:\\Users\\u\\.ai_home\\pkg\\lib\\cli\\entry.js' }),
    resolveStartServeArgs: () => ['--host', '127.0.0.1', '--port', '9527']
  });
  return { service, written, calls };
}

test('Windows autostart writes the meadeo startup script when the folder is writable', () => {
  const { service, written, calls } = createWindowsHarness();
  const status = service.install();
  const startup = written.get('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\com.meadeo.ai_home.vbs');
  assert.ok(startup, 'new brand startup script should be written');
  assert.equal(status.type, 'windows-startup');
  assert.equal(status.label, 'com.meadeo.ai_home');
  assert.ok(
    calls.some((args) => args.join(' ') === 'schtasks /Delete /TN com.clawdcodex.ai_home /F'),
    'legacy brand scheduled task should be removed'
  );
});

test('Windows autostart falls back to an ONLOGON scheduled task when .vbs is denied', () => {
  const { service, written, calls } = createWindowsHarness({ failVbs: true });
  const status = service.install();
  const serveScript = written.get('C:\\Users\\u\\.ai_home\\run\\aih-server-serve.cmd');
  assert.ok(serveScript, 'fallback serve script should be written');
  assert.match(serveScript, /aih\.exe/);
  assert.match(serveScript, /"server" "serve"/);
  assert.equal(status.type, 'windows-scheduled-task');
  assert.equal(status.installed, true);
  assert.equal(status.file, 'C:\\Users\\u\\.ai_home\\run\\aih-server-serve.cmd');
  assert.ok(
    calls.some((args) => args.join(' ').includes('/Create') && args.join(' ').includes('/SC ONLOGON') && args.join(' ').includes('/TN com.meadeo.ai_home')),
    'ONLOGON scheduled task should be created for the new brand label'
  );
});
