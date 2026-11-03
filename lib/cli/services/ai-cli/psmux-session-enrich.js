'use strict';

// Native-Windows psmux cannot mark a pane dead the way tmux does, so a
// finished CLI leaves a session that LOOKS alive. This probe captures the last
// screen lines of each session and flags "Session completed" screens, letting
// both the session list and the launch planner treat them as completed.
// Single shared implementation — used by persistent-session-list (display) and
// pty/persistent-launch (session planning).

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const persistentSession = require('../../../runtime/persistent-session');

function enrichNativeWindowsPsmuxSessions(cliName, runtimeScope, tmux, sessions, options = {}) {
  if (!persistentSession.isNativeWindowsPsmuxCommand(tmux && tmux.command, options.platform)) {
    return sessions;
  }
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  const env = options.env || {};
  return (Array.isArray(sessions) ? sessions : []).map((session) => {
    if (!session || !persistentSession.isSafeSessionName(session.name)) return session;
    if (session.paneDeadChecked && session.paneDead) return session;
    const cmd = persistentSession.buildCapturePaneCommand({
      cliName,
      runtimeScope,
      tmuxCommand: tmux.command,
      sessionName: session.name,
      start: -80
    });
    if (!cmd) return session;
    try {
      const res = spawnSyncImpl(cmd.command, cmd.args, {
        encoding: 'utf8',
        env
      });
      if (!res || res.error || res.status !== 0) return session;
      return {
        ...session,
        screenCompletedChecked: true,
        screenCompleted: persistentSession.isCompletedSessionScreen(res.stdout)
      };
    } catch (_error) {
      return session;
    }
  });
}

module.exports = {
  enrichNativeWindowsPsmuxSessions
};
