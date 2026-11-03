'use strict';

// 安装之后必须做的修补。
//
// 目前唯一一项，但它很要命：codex 官方 install.sh 的 update_visible_command 会把
// `$BIN_DIR/codex`（默认 ~/.local/bin/codex）替换成指向 standalone/current 的符号链接，
// 而那个位置正是 aih 自己的 CLI hook 垫片（`# aih-codex-cli-hook-alias`）。
// 也就是说**每一次 standalone 升级都会静默拆掉 aih 对 codex 的接管**，而且悄无声息：
// codex 照常能跑，只是会话同步、resume 拦截这些经 hook 的能力全部失效。
//
// 所以升级/回滚之后都要把 hook 装回去。这一步失败必须让整次 apply 判失败 ——
// 拿到一个「版本升上去了但 aih 接管没了」的半吊子状态，比升级失败更糟。

const POST_INSTALL_ACTIONS = Object.freeze({
  REINSTALL_CODEX_CLI_HOOK: 'reinstall_codex_cli_hook'
});

function collectPostInstallActions(plans = []) {
  const actions = [];
  for (const plan of Array.isArray(plans) ? plans : []) {
    for (const action of Array.isArray(plan && plan.postInstall) ? plan.postInstall : []) {
      if (!actions.includes(action)) actions.push(action);
    }
  }
  return actions;
}

/**
 * 执行 plan 声明的善后动作。
 *
 * deps.reinstallCodexCliHook() -> {ok, error?}
 * 未注入对应实现时按「跳过」处理而非失败：调用方可能刻意不接管 hook。
 */
async function runPostInstallActions(actions, deps = {}) {
  const performed = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action === POST_INSTALL_ACTIONS.REINSTALL_CODEX_CLI_HOOK) {
      if (typeof deps.reinstallCodexCliHook !== 'function') {
        performed.push({ action, ok: true, skipped: true });
        continue;
      }
      try {
        const result = await deps.reinstallCodexCliHook();
        const ok = !result || result.ok !== false;
        performed.push({ action, ok, error: ok ? '' : String(result.error || 'hook_reinstall_failed') });
        if (!ok) return { ok: false, performed, failedAction: action };
      } catch (error) {
        performed.push({ action, ok: false, error: String(error && error.message || error) });
        return { ok: false, performed, failedAction: action };
      }
      continue;
    }
    performed.push({ action, ok: true, skipped: true, error: 'unknown_action' });
  }
  return { ok: true, performed, failedAction: '' };
}

module.exports = {
  POST_INSTALL_ACTIONS,
  collectPostInstallActions,
  runPostInstallActions
};
