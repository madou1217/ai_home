'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_FILE_AUTH_TYPE = 'key-file';

class SshIdentityFileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SshIdentityFileError';
    this.code = code;
  }
}

function isPathInside(parentDir, candidate) {
  const relative = path.relative(parentDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveIdentityFilePath(value, options = {}) {
  const fsImpl = options.fs || fs;
  const homeDir = path.resolve(String(options.homeDir || os.homedir()).trim());
  const input = String(value || '').trim();
  if (!input) throw new SshIdentityFileError('identity_file_required');

  const expanded = input === '~'
    ? homeDir
    : input.startsWith('~/')
      ? path.join(homeDir, input.slice(2))
      : input;
  if (!path.isAbsolute(expanded)) {
    throw new SshIdentityFileError('identity_file_must_be_absolute');
  }

  const sshDir = path.resolve(homeDir, '.ssh');
  const candidate = path.resolve(expanded);
  if (!isPathInside(sshDir, candidate)) {
    throw new SshIdentityFileError('identity_file_outside_ssh_dir');
  }

  let realSshDir = '';
  let realIdentityFile = '';
  try {
    realSshDir = fsImpl.realpathSync(sshDir);
    realIdentityFile = fsImpl.realpathSync(candidate);
  } catch (_error) {
    throw new SshIdentityFileError('identity_file_not_found');
  }
  if (!isPathInside(realSshDir, realIdentityFile)) {
    throw new SshIdentityFileError('identity_file_outside_ssh_dir');
  }

  const stat = fsImpl.statSync(realIdentityFile);
  if (!stat.isFile()) throw new SshIdentityFileError('identity_file_not_regular_file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new SshIdentityFileError('identity_file_permissions_too_open');
  }
  return realIdentityFile;
}

module.exports = {
  KEY_FILE_AUTH_TYPE,
  SshIdentityFileError,
  resolveIdentityFilePath
};
