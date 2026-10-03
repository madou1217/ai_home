'use strict';

module.exports = Object.freeze({
  id: 'herdr',
  category: 'session-runtimes',
  name: 'herdr',
  role: '持久会话运行时',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['herdr']),
  versionArgs: Object.freeze([['--version'], ['-V']]),
  capabilities: Object.freeze(['detect', 'version', 'sessions']),
  config: null
});
