'use strict';

const { HISTORY_SCAN_LIMIT } = require('./history');

const CHUNK_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

// Completion only consumes recent history. Read backwards, bounded by both
// lines and bytes, instead of allocating/splitting the whole history on TAB.
function readHistoryTail(fs, file) {
  // Nonblocking open also protects against HISTFILE accidentally pointing at
  // a FIFO; fstat below rejects every non-regular source.
  const { constants } = require('node:fs');
  const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return '';
    let offset = stat.size;
    let total = 0;
    let newlines = 0;
    const chunks = [];
    while (offset > 0 && total < MAX_HISTORY_BYTES && newlines <= HISTORY_SCAN_LIMIT) {
      const length = Math.min(CHUNK_BYTES, offset, MAX_HISTORY_BYTES - total);
      offset -= length;
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, offset);
      if (!read) break;
      const chunk = buffer.subarray(0, read);
      chunks.push(chunk);
      total += read;
      for (const byte of chunk) if (byte === 10) newlines += 1;
    }
    let bytes = Buffer.concat(chunks.reverse());
    if (offset > 0) {
      // Never interpret a partial first line (or split UTF-8 code point) as a
      // new executable history suggestion. Pathological single lines are skipped.
      const boundary = bytes.indexOf(10);
      if (boundary < 0) return '';
      bytes = bytes.subarray(boundary + 1);
    }
    return bytes.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { MAX_HISTORY_BYTES, readHistoryTail };
