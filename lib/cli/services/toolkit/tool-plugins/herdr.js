'use strict';

const { lifecycle, preferredExecutable } = require('../tool-lifecycle/herdr-lifecycle');
const { herdrConfigPath, validateToml } = require('./session-config');

module.exports = Object.freeze({
  id: 'herdr',
  category: 'session-runtimes',
  name: 'herdr',
  role: '后台会话运行时',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['herdr']),
  versionArgs: Object.freeze([['--version'], ['-V']]),
  capabilities: Object.freeze(['detect', 'version', 'sessions', 'config-edit', 'config-validate']),
  config: Object.freeze({ name: 'config.toml', format: 'toml', resolvePath: herdrConfigPath,
    template: '# Herdr user configuration\n', validate: validateToml,
    note: 'Herdr 原生配置；保存后运行 herdr server reload-config。AIH 交互 CLI 当前使用 tmux / psmux；不兼容的 Herdr 版本不会被后台运行自动选中。' }),
  resolveExecutableFallback: preferredExecutable,
  lifecycle
});
