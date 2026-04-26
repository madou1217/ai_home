'use strict';

const { spawnSync } = require('node:child_process');
const { resolveCommandPath } = require('./command-path');

function configureConsoleEncoding(options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  if (platform !== 'win32') return;

  try {
    spawnSyncImpl('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul'], { stdio: 'ignore' });
  } catch (_error) {
    // best effort only
  }

  try {
    if (stdout && typeof stdout.setDefaultEncoding === 'function') {
      stdout.setDefaultEncoding('utf8');
    }
    if (stderr && typeof stderr.setDefaultEncoding === 'function') {
      stderr.setDefaultEncoding('utf8');
    }
  } catch (_error) {
    // best effort only
  }
}

function resolveCliPath(commandName, options = {}) {
  return resolveCommandPath(commandName, options);
}

function commandExists(commandName, options = {}) {
  return Boolean(resolveCliPath(commandName, options));
}

module.exports = {
  commandExists,
  configureConsoleEncoding,
  resolveCliPath
};

