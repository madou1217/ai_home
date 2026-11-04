'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBackupConfig } = require('../lib/account/backup/remote-backup-config');
const { runBackupCommand, runBackupSubcommand } = require('../lib/cli/commands/backup/router');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(t) {
  const dir = home(t);
  const logs = [];
  const errors = [];
  const processImpl = {
    env: { ...process.env },
    exitCode: null,
    exit(code) { this.exitCode = code; }
  };
  const deps = {
    fs,
    path,
    aiHomeDir: dir,
    consoleImpl: {
      log: (message) => logs.push(String(message)),
      error: (message) => errors.push(String(message))
    },
    processImpl
  };
  return { dir, deps, logs, errors, processImpl };
}

test('backup add/list/config/remove manage targets', async (t) => {
  const { dir, deps, logs } = harness(t);
  assert.equal(await runBackupSubcommand(['add', 'ubuntu@203.0.113.10', '--name', 'aws', '--key', '~/.ssh/backup.pem'], deps), 0);
  assert.match(logs.join('\n'), /已添加备份目标 aws/);
  let config = readBackupConfig({ fs, aiHomeDir: dir });
  assert.equal(config.targets[0].id, 'aws');
  assert.equal(config.targets[0].identityFile, '~/.ssh/backup.pem');

  logs.length = 0;
  assert.equal(await runBackupSubcommand(['list'], deps), 0);
  assert.match(logs.join('\n'), /aws/);
  assert.match(logs.join('\n'), /尚未备份/);

  assert.equal(await runBackupSubcommand(['config', '--interval', '15', '--enabled', 'off'], deps), 0);
  config = readBackupConfig({ fs, aiHomeDir: dir });
  assert.equal(config.intervalMinutes, 15);
  assert.equal(config.enabled, false);

  assert.equal(await runBackupSubcommand(['remove', 'aws'], deps), 0);
  assert.equal(readBackupConfig({ fs, aiHomeDir: dir }).targets.length, 0);
});

test('backup --help and bare backup print usage with remote commands', async (t) => {
  const { deps, logs } = harness(t);
  assert.equal(await runBackupSubcommand(['--help'], deps), 0);
  const help = logs.join('\n');
  assert.match(help, /远程自动备份/);
  assert.match(help, /aih backup add/);
  assert.match(help, /aih backup restore/);

  logs.length = 0;
  assert.equal(await runBackupSubcommand([], deps), 0);
  assert.match(logs.join('\n'), /还没有远程备份目标/);
});

test('backup output uses real ANSI escapes instead of literal backslash-x1b', async (t) => {
  const { deps, logs } = harness(t);
  assert.equal(await runBackupSubcommand(['--help'], deps), 0);
  const help = logs.join('\n');
  assert.ok(help.includes('\u001b[36m'), 'help should contain a real ESC color code');
  assert.equal(help.includes('\\x1b'), false, 'literal backslash-x1b means the escape was double-escaped');
});

test('backup rejects unknown subcommands and missing values', async (t) => {
  const { deps } = harness(t);
  await assert.rejects(() => runBackupSubcommand(['bogus'], deps), /未知的 backup 子命令/);
  await assert.rejects(() => runBackupSubcommand(['add'], deps), /用法/);
  await assert.rejects(() => runBackupSubcommand(['add', 'u@h', '--port'], deps), /需要一个值/);
});

test('runBackupCommand dispatches backup and exits with the subcommand code', async (t) => {
  const { deps, processImpl, errors } = harness(t);
  assert.equal(await runBackupCommand('backup', ['backup', 'list'], deps), true);
  assert.equal(processImpl.exitCode, 0);

  assert.equal(await runBackupCommand('backup', ['backup', 'bogus'], deps), true);
  assert.equal(processImpl.exitCode, 1);
  assert.match(errors.join('\n'), /未知的 backup 子命令/);

  assert.equal(await runBackupCommand('ls', ['ls'], deps), false);
});
