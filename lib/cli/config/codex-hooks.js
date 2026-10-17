'use strict';

// Codex hook 安装开关（CLI / 桌面 App 两个垫片）。默认都装；
// `AIH_CODEX_FLAGS` 的 hooks=cli|desktop|cli,desktop|none 可选择性关闭。

function parseCodexHookFlags(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!raw) return { cli: true, desktop: true };
  if (['0', 'false', 'off', 'no', 'none'].includes(raw)) return { cli: false, desktop: false };
  if (['1', 'true', 'on', 'yes', 'all'].includes(raw)) return { cli: true, desktop: true };
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return { cli: items.includes('cli'), desktop: items.includes('desktop') };
}

module.exports = { parseCodexHookFlags };
