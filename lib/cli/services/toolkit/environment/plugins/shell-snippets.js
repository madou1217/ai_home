'use strict';

const { shellQuote } = require('../plan-builders');

/**
 * 解析用户级工具的可执行路径：优先已知安装位置，其次 PATH。
 * 服务进程 PATH 可能不含 ~/.cargo/bin 等目录，直接调用命令名会误判未安装。
 */
function resolveBinarySnippet(variable, knownPath, command) {
  return [
    `${variable}=${shellQuote(knownPath)}`,
    `if [ ! -x "$${variable}" ]; then ${variable}="$(command -v ${command} || true)"; fi`,
    `if [ -z "$${variable}" ]; then echo "未找到 ${command}" >&2; exit 127; fi`
  ];
}

/**
 * 向常见 Shell 配置追加初始化行（按标记去重）；卸载时由 buildProfileAwareCleanupPlan 按同一标记移除。
 */
function appendProfileLinesSnippet(home, marker, lines) {
  return [
    `touch ${shellQuote(`${home}/.profile`)}`,
    `for profile in ${['.zshrc', '.bashrc', '.profile'].map((name) => shellQuote(`${home}/${name}`)).join(' ')}; do`,
    '  [ -f "$profile" ] || continue',
    `  if ! grep -qF ${shellQuote(marker)} "$profile"; then`,
    `    { printf '\\n'; printf '%s\\n' ${lines.map((line) => shellQuote(line)).join(' ')}; } >> "$profile"`,
    '  fi',
    'done'
  ];
}

module.exports = {
  appendProfileLinesSnippet,
  resolveBinarySnippet
};
