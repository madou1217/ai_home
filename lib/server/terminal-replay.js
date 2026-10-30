'use strict';

// Terminal queries are meaningful only while the original PTY is waiting for
// a reply. Replaying them later makes xterm send stale replies as shell input.
// Strip queries from snapshots only; live output still carries them unchanged.
function replayableTerminalOutput(buffer) {
  return buffer.join('')
    .replace(/\x1b\[[?>]?[\d;]*c/g, '')
    .replace(/\x1b\[\??(?:5|6|15|25|26|53|55|56|62|63|75|85|996)n/g, '')
    .replace(/\x1b\[(?:14|16|18|19|20|21)t/g, '')
    .replace(/\x1b\[>q/g, '')
    .replace(/\x1b\](?:10|11|12);\?(?:\x07|\x1b\\)/g, '');
}

module.exports = { replayableTerminalOutput };
