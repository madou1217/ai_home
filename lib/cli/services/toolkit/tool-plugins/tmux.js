'use strict';

module.exports = Object.freeze({
  id: 'tmux',
  category: 'session-runtimes',
  name: 'tmux',
  role: 'POSIX 会话复用器',
  // 原生 Windows 用 psmux；那里 PATH 上的 tmux.exe 是 psmux 自带的别名（WSL 内的 tmux 从
  // Windows 侧探测不到），再列一次只会把同一个程序显示成两个运行时。
  platforms: Object.freeze(['darwin', 'linux']),
  commands: Object.freeze(['tmux']),
  versionArgs: Object.freeze([['-V'], ['--version']]),
  capabilities: Object.freeze(['detect', 'version', 'sessions']),
  config: null
});
