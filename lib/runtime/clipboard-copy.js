'use strict';

/**
 * 把文本写进系统剪贴板（best-effort，跨平台）。
 *
 * 只用系统自带/常见的命令行工具，不引依赖：
 *   darwin  pbcopy
 *   win32   clip
 *   linux   wl-copy → xclip → xsel（Wayland 优先）
 * 失败不抛错：拿不到剪贴板时调用方退回"打印到终端"。
 */

const { spawnSync } = require('node:child_process');

const CANDIDATES = Object.freeze({
  darwin: [['pbcopy', []]],
  win32: [['clip', []]],
  linux: [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
});

function copyText(text, options = {}) {
  const value = String(text == null ? '' : text);
  if (!value) return { ok: false, reason: 'empty' };
  const platform = String(options.platform || process.platform);
  const runner = options.spawnSync || spawnSync;
  const candidates = CANDIDATES[platform] || [];
  for (const [command, args] of candidates) {
    try {
      const result = runner(command, args, { input: value, encoding: 'utf8', windowsHide: true });
      if (result && (result.status === 0 || result.status === null)) {
        return { ok: true, method: command };
      }
    } catch (_error) {
      /* 换下一个工具 */
    }
  }
  return { ok: false, reason: 'no_clipboard_tool' };
}

module.exports = { copyText };
