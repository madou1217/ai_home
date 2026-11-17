'use strict';

const { createHash } = require('node:crypto');
const persistentSession = require('../../../../runtime/persistent-session');

// Keep one recent observation per target across daemon ticks. Cursor blinking
// changes window_activity without changing the visible content of an idle TUI.
function createPaneActivityTracker() {
  const entries = new Map();
  return (options) => {
    const capture = persistentSession.buildCapturePaneCommand(options);
    if (!capture) return 0;
    const args = capture.args.slice();
    const start = args.indexOf('-S');
    if (start >= 0) args.splice(start, 2);
    const result = options.spawnSyncImpl(capture.command, args, {
      encoding: 'utf8', env: options.env, timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!result || result.status !== 0) return 0;
    const digest = createHash('sha256').update(String(result.stdout || '')).digest('hex');
    const key = [options.cliName, options.runtimeScope, options.sessionName].join('\0');
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const previous = entries.get(key);
    if (!previous || previous.digest !== digest) {
      entries.delete(key);
      entries.set(key, { digest, at: now });
      if (entries.size > 1024) entries.delete(entries.keys().next().value);
      return now;
    }
    return previous.at;
  };
}

module.exports = { createPaneActivityTracker };
