'use strict';

// The shell installer owns only one marked region. Preserve the surrounding
// bytes and location; incomplete/duplicate markers are not a license to delete.
const crypto = require('node:crypto');
const JOIN_PREFIX = '# aih-shell-joined-newline: ';
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const { buildManagedBlockMarkers } = require('../../../runtime/managed-text-block');

function inspectBlock(text, name, options = {}) {
  const markers = buildManagedBlockMarkers(name, options.prefix);
  const found = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === markers.start || trimmed === markers.end) {
      found.push({ type: trimmed === markers.start ? 'start' : 'end', start: offset, end: offset + line.length });
    }
    offset += line.length;
  }
  if (found.length === 0) return null;
  if (found.length !== 2 || found[0].type !== 'start' || found[1].type !== 'end') {
    throw new Error('shell_rc_managed_block_invalid');
  }
  const body = text.slice(found[0].end, found[1].start);
  const join = body.split(/\r?\n/).find((line) => line.startsWith(JOIN_PREFIX));
  return { start: found[0].start, end: found[1].end, joinDigest: join ? join.slice(JOIN_PREFIX.length) : '' };
}

function replaceRcBlock(text, name, content, options = {}) {
  const span = inspectBlock(text, name, options);
  const { start, end } = buildManagedBlockMarkers(name, options.prefix);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const needsJoin = !span && text && !text.endsWith('\n');
  const joinDigest = span ? span.joinDigest : needsJoin ? digest(text) : '';
  const lines = [start];
  if (joinDigest) lines.push(JOIN_PREFIX + joinDigest);
  lines.push(content.trim().replace(/\r?\n/g, newline), end);
  const block = lines.join(newline);
  if (span) {
    const suffix = text.slice(span.end);
    const hadNewline = text.slice(span.start, span.end).endsWith('\n');
    return text.slice(0, span.start) + block + (hadNewline ? newline : '') + suffix;
  }
  return text + (text && !text.endsWith('\n') ? newline : '') + block + newline;
}

function removeRcBlock(text, name, options = {}) {
  const span = inspectBlock(text, name, options);
  if (!span) return { text, removed: false };
  let prefix = text.slice(0, span.start);
  const withoutJoin = prefix.replace(/\r?\n$/, '');
  // Only undo our separator if the preceding user bytes still match; never
  // guess after a user edits the rc while the integration is installed.
  if (span.end === text.length && span.joinDigest && digest(withoutJoin) === span.joinDigest) prefix = withoutJoin;
  return { text: prefix + text.slice(span.end), removed: true };
}

module.exports = { inspectBlock, replaceRcBlock, removeRcBlock };
