'use strict';

// kiro 的权限旗标（`-a` / `--trust-all-tools`）放在哪里。
//
// 事实（2026-10-22，kiro-cli 2.32.0 实测）：
//   - `-a, --trust-all-tools` 的说明是「Allows the model to use any tool to run commands
//     without asking for confirmation」，`--trust-tools <名单>` 是它的部分信任版本；
//   - 它属于 **`chat` 子命令**，不是根命令：`kiro-cli -a --help` 退出码 2（被拒），
//     `kiro-cli chat -a --help` 退出码 0（接受）；`agent` / `settings` 也不接受；
//   - aih 裸启动 kiro 时会自动补 `chat` 子命令（见 kiro-strategy 的 buildRuntimeArgs），
//     所以参数整形之后首位就是 `chat`，权限旗标要插在它后面。
//
// 于是规则与 opencode 同构：首个参数是 `chat` → 插在它后面；其它子命令 → 不加
// （加了必挂，且那些子命令没有权限决策可放开）。

const SESSION_SUBCOMMAND = 'chat';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把权限旗标插到 kiro 认它的位置；不该加时原样返回。
 *
 * @param {string[]} args 调用方已整形好的参数（裸启动时首位已被补成 `chat`）
 * @param {string[]} permissionArgs 合同推导出的权限旗标（如 `['--trust-all-tools']`）
 * @returns {string[]}
 */
function placeKiroPermissionArgs(args, permissionArgs) {
  const current = Array.isArray(args) ? args.slice() : [];
  const extra = Array.isArray(permissionArgs) ? permissionArgs.filter((arg) => normalizeString(arg)) : [];
  if (extra.length === 0) return current;
  const first = normalizeString(current[0]);
  if (first === SESSION_SUBCOMMAND) return [current[0], ...extra, ...current.slice(1)];
  // 根级参数（`--help` 等）与其它子命令都不认这个旗标：不加，保持原生行为。
  return current;
}

module.exports = {
  placeKiroPermissionArgs
};
