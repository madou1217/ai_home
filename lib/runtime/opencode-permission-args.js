'use strict';

// opencode 的权限旗标（`--auto`）放在哪里。
//
// 事实（2026-10-20，opencode 2.0.32 与 1.18.18 逐个实测）：
//   - `--auto` 只属于根命令（TUI）和 `run` 子命令，两者的 `--help` 都列着它；
//   - 写在子命令**前面**一律被拒：`opencode --auto run …` →
//     `ERROR Unrecognized flag: --auto in command opencode run`（models / session / mcp 同样被拒）；
//   - 其它子命令（serve、models、session、mcp、auth…）根本不认它：`opencode serve --auto`
//     同样 `Unrecognized flag`。
// 于是规则：没有子命令（TUI）→ 放最前；首个参数是 `run` → 紧跟在 `run` 后面；
// 其它子命令 → 不加（加了必挂，那些子命令也没有权限决策可放开）。
//
// 子命令是否认这个旗标不靠写死清单判断：根命令与 `run` 是 opencode 唯二的会话入口，
// 其余都是管理类子命令。首个参数是旗标（`-m x`、`--continue`）时整行都是根命令的参数。

const SESSION_SUBCOMMAND = 'run';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把权限旗标插到 opencode 认它的位置；不该加时原样返回。
 *
 * @param {string[]} args 调用方已整形好的参数（可能已带 `--standalone`）
 * @param {string[]} permissionArgs 合同推导出的权限旗标（如 `['--auto']`）
 * @returns {string[]}
 */
function placeOpenCodePermissionArgs(args, permissionArgs) {
  const current = Array.isArray(args) ? args.slice() : [];
  const extra = Array.isArray(permissionArgs) ? permissionArgs.filter((arg) => normalizeString(arg)) : [];
  if (extra.length === 0) return current;
  const first = normalizeString(current[0]);
  if (!first || first.startsWith('-')) return [...extra, ...current];
  if (first === SESSION_SUBCOMMAND) return [current[0], ...extra, ...current.slice(1)];
  return current;
}

module.exports = {
  placeOpenCodePermissionArgs
};
