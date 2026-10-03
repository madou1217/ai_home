'use strict';

module.exports = Object.freeze({
  id: 'tmux',
  category: 'session-runtimes',
  name: 'tmux',
  role: 'POSIX/WSL 会话复用器',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['tmux']),
  versionArgs: Object.freeze([['-V'], ['--version']]),
  capabilities: Object.freeze(['detect', 'version', 'sessions']),
  config: null
});
