'use strict';

const persistentSession = require('../../../../runtime/persistent-session');

function composerEnd(lines) {
  const pane = lines.slice();
  while (pane.length && pane[pane.length - 1] === '') pane.pop();
  if (pane.length < 2) return -1;
  const end = pane.length - 1;
  if (!/^\s*(?:.*\? (?:for )?shortcuts|\d+% context left)/u.test(pane[end])) {
    if (pane[end].includes(' · ') && end >= 2
      && /^\s*[➜❯] /u.test(pane[end - 1]) && /^\s*[─━═-]{3,}\s*$/u.test(pane[end - 2])) return end - 2;
    if (pane[end].includes(' · ') && pane[end].includes('← for agents')) return end;
    return -1;
  }
  if (/^\s*[─━═-]{3,}\s*$/u.test(pane[end - 1]) || pane[end - 1].includes(' · ')) return end - 1;
  return -1;
}

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
    if (!capture) return 'unknown';
    if (cursor.status !== 0) {
      const display = command.args.indexOf('display-message');
      const sessions = run([...command.args.slice(0, display), 'list-sessions', '-F', '#{session_name}']);
      if (sessions.status === 0 && !String(sessions.stdout).split('\n').some((name) => name.trim() === options.sessionName)) return 'gone';
      return 'unknown';
    }
    const paneArgs = capture.args.slice();
    const start = paneArgs.indexOf('-S');
    if (start >= 0) paneArgs.splice(start, 2);
    const pane = run(paneArgs);
    const y = Number(String(cursor.stdout).trim());
    if (pane.status !== 0 || !Number.isInteger(y) || y < 0) return 'unknown';
    const lines = String(pane.stdout || '').split('\n');
    const end = composerEnd(lines);
    if (end < 0 || y >= end) return 'unknown';
    for (let row = y; row >= 0; row -= 1) {
      if (/^\s*[─━═-]{3,}\s*$/u.test(lines[row] || '')) break;
      const match = lines[row]?.match(/^\s*[›❯>](?: (.*))?$/u);
      if (!match) continue;
      for (let below = y + 1; below < end; below += 1) {
        if (lines[below].trim()) return 'draft';
      }
      const text = [match[1], ...lines.slice(row + 1, y + 1)].join('\n').trim();
      if (!text || ['Ask Codex to do anything', 'Type a message', 'Ask anything'].includes(text)) return 'empty';
      return 'draft';
    }
  } catch (_error) { /* An uncertain pane remains queued. */ }
  return 'unknown';
}

module.exports = { inspectComposer };
