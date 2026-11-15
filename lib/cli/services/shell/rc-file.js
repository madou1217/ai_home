'use strict';

// Own only filesystem concerns: follow dotfile links, preserve permissions,
// back up the exact prior bytes and refuse stale snapshots before replacement.
const path = require('node:path');
const crypto = require('node:crypto');
const { isUtf8 } = require('node:buffer');

function readSnapshot(fs, file) {
  let link;
  try {
    link = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { file, target: file, exists: false, text: '', mode: 0o600, encoding: 'utf8', bom: '' };
    throw error;
  }
  const target = link.isSymbolicLink() ? fs.realpathSync(file) : file;
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('shell_config_not_regular_file');
  const bytes = fs.readFileSync(target);
  const decoded = decodeText(bytes);
  return { file, target, exists: true, ...decoded, mode: stat.mode & 0o777,
    ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
}

// PowerShell 5 profiles commonly use UTF-16 with a BOM. Preserve the encoding
// as well as the text; malformed bytes fail closed rather than being replaced.
function decodeText(bytes) {
  const prefix = bytes.subarray(0, 3).toString('hex');
  let encoding = 'utf8';
  let bom = '';
  if (prefix.startsWith('fffe')) { encoding = 'utf16le'; bom = 'fffe'; }
  else if (prefix.startsWith('feff')) { encoding = 'utf16be'; bom = 'feff'; }
  else if (prefix === 'efbbbf') bom = 'efbbbf';
  const body = bytes.subarray(bom.length / 2);
  if ((encoding === 'utf8' && !isUtf8(body)) || (encoding !== 'utf8' && body.length % 2)) {
    throw new Error('shell_config_encoding_unsupported');
  }
  const text = encoding === 'utf16be'
    ? Buffer.from(body).swap16().toString('utf16le') : body.toString(encoding);
  const result = { text, encoding, bom };
  if (!encodeText(text, result).equals(bytes)) throw new Error('shell_config_encoding_unsupported');
  return result;
}

function encodeText(text, snapshot) {
  const encoding = snapshot.encoding || 'utf8';
  const body = Buffer.from(text, encoding === 'utf16be' ? 'utf16le' : encoding);
  if (encoding === 'utf16be') body.swap16();
  return Buffer.concat([Buffer.from(snapshot.bom || '', 'hex'), body]);
}

function sameSnapshot(left, right) {
  return left.exists === right.exists && left.target === right.target
    && left.mode === right.mode && left.text === right.text
    && left.encoding === right.encoding && left.bom === right.bom
    && left.ino === right.ino && left.dev === right.dev && left.mtimeMs === right.mtimeMs;
}

function writeSnapshot(fs, snapshot, content, options = {}) {
  const current = readSnapshot(fs, snapshot.file);
  if (!sameSnapshot(snapshot, current)) throw new Error('shell_config_changed_retry');
  const dir = path.dirname(snapshot.target);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const temporary = path.join(dir, `.${path.basename(snapshot.target)}.aih-tmp-${nonce}`);
  let backupPath = '';
  let created = false;
  let fd;
  try {
    // Exclusive create: never follow an attacker-prepared temporary symlink.
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    const encoding = options.outputEncoding || snapshot.encoding;
    const bom = options.outputBom === undefined ? snapshot.bom : options.outputBom;
    fs.writeFileSync(fd, encodeText(content, { encoding, bom }));
    fs.fchmodSync(fd, snapshot.mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (options.backup && snapshot.exists) {
      backupPath = `${snapshot.target}.aih-backup-${Date.now()}-${nonce}`;
      fs.writeFileSync(backupPath, encodeText(snapshot.text, snapshot), { flag: 'wx', mode: snapshot.mode });
    }
    if (!sameSnapshot(snapshot, readSnapshot(fs, snapshot.file))) throw new Error('shell_config_changed_retry');
    fs.renameSync(temporary, snapshot.target);
    return { backupPath };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = { readSnapshot, writeSnapshot };
