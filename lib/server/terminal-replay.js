'use strict';

// Cached tmux client queries can expire before replay; answering them later
// sends stale replies as shell input. Live output still carries queries unchanged.
function replayableTerminalOutput(session) {
  const output = session.buffer.join('');
  // A direct PTY may still be waiting for a reply from its first browser.
  // tmux answers its pane's queries itself; its cached outer-client probes are stale.
  if (!session.durable) return output;
  return output
    .replace(/\x1b\[[?>]?[\d;]*c/g, '')
    .replace(/\x1b\[\??(?:5|6|15|25|26|53|55|56|62|63|75|85|996)n/g, '')
    .replace(/\x1b\[(?:14|16|18|19|20|21)t/g, '')
    .replace(/\x1b\[>q/g, '')
    .replace(/\x1b\](?:10|11|12);\?(?:\x07|\x1b\\)/g, '');
}

module.exports = { replayableTerminalOutput };
