'use strict';

const persistentSession = require('../../../../runtime/persistent-session');

// Quiet output is not an empty composer. Never append a peer notification to a
// user's draft, or to a shell/permission prompt we cannot identify safely.
function inspectComposer(options) {
  const command = persistentSession.buildWindowActivityCommand(options);
  if (!command) return 'unknown';
  const run = (args) => options.spawnSyncImpl(command.command, args, {
    encoding: 'utf8', env: options.env, timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  try {
    const cursorArgs = command.args.slice();
    cursorArgs[cursorArgs.length - 1] = '#{cursor_y}';
    const cursor = run(cursorArgs);
    const capture = persistentSession.buildCapturePaneCommand(options);
    if (!capture || cursor.status !== 0) return 'unknown';
    const paneArgs = capture.args.slice();
    const start = paneArgs.indexOf('-S');
    if (start >= 0) paneArgs.splice(start, 2);
    const pane = run(paneArgs);
    const y = Number(String(cursor.stdout).trim());
    if (pane.status !== 0 || !Number.isInteger(y) || y < 0) return 'unknown';
    const lines = String(pane.stdout || '').split('\n');
    for (let row = y; row >= 0; row -= 1) {
      const match = lines[row]?.match(/^\s*[›❯>] (.*)$/u);
      if (!match) continue;
      const text = [match[1], ...lines.slice(row + 1, y + 1)].join('\n').trim();
      if (!text || ['Ask Codex to do anything', 'Type a message', 'Ask anything'].includes(text)) return 'empty';
      return 'draft';
    }
  } catch (_error) { /* An uncertain pane remains queued. */ }
  return 'unknown';
}

module.exports = { inspectComposer };
