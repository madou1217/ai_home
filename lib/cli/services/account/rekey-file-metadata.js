'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/**
 * Capture a hash of inode-level security metadata without persisting or logging
 * attribute values. Replacing bytes must not drop ACLs, quarantine/provenance or
 * other xattrs. Maintenance uses the platform's metadata-preserving file copy;
 * the copied template is verified before any original inode is replaced.
 */
function inspectReplaceableMetadata(file, stat, options = {}) {
  if (stat.nlink > 1) throw new Error('rekey_hardlinked_machine_file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('rekey_file_owner_mismatch');
  const execute = options.execFileSync || execFileSync;
  const platform = options.platform || process.platform;
  const run = (command, args) => execute(command, args, {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    let attributes;
    let acl = [];
    if (platform === 'darwin') {
      const names = run('/usr/bin/xattr', [file]).split('\n').filter(Boolean).sort();
      attributes = names.map(name => [name, run('/usr/bin/xattr', ['-px', name, file]).replace(/\s/g, '')]);
      acl = run('/bin/ls', ['-lde', file]).split('\n').filter(line => /^\s*\d+:/.test(line)).map(line => line.trim());
    } else if (platform === 'linux') {
      attributes = JSON.parse(run('python3', ['-c',
        'import os,sys,json; p=sys.argv[1]; print(json.dumps([[n,os.getxattr(p,n,follow_symlinks=False).hex()] for n in sorted(os.listxattr(p,follow_symlinks=False))]))', file]));
      if (!Array.isArray(attributes)) throw new Error('rekey_metadata_unverifiable');
    } else throw new Error('rekey_metadata_platform_unsupported');
    return crypto.createHash('sha256').update(JSON.stringify({ uid: stat.uid, gid: stat.gid,
      mode: stat.mode & 0o777, attributes, acl })).digest('hex');
  } catch (error) {
    if (typeof error.message === 'string' && error.message.startsWith('rekey_')) throw error;
    throw new Error('rekey_metadata_unverifiable');
  }
}

function copyMetadataTemplate(fs, source, temporary, expected, options = {}) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
    || inspectReplaceableMetadata(source, sourceStat, options) !== expected.metadataDigest) {
    throw new Error('rekey_source_metadata_changed');
  }
  const execute = options.execFileSync || execFileSync;
  const platform = options.platform || process.platform;
  try {
    const args = platform === 'darwin' ? ['-p', source, temporary] : ['--preserve=all', '--', source, temporary];
    execute('/bin/cp', args, { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (_) { throw new Error('rekey_metadata_copy_failed'); }
  const copied = fs.lstatSync(temporary);
  if (!copied.isFile() || copied.isSymbolicLink() || inspectReplaceableMetadata(temporary, copied, options) !== expected.metadataDigest) {
    throw new Error('rekey_metadata_copy_mismatch');
  }
}

module.exports = { inspectReplaceableMetadata, copyMetadataTemplate };
