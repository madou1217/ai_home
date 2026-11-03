'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { collectDesktopStatus } = require('../../server/desktop-launch/desktop-status');

// `aih desktop`：桌面端（zcode / workbuddy family / codebuddy family …）的全局视图。
//
// P0 只做只读的 status：canonical 版本、影子副本、运行中版本、以及「谁落后了」。
// 统一升级（download once → 替换 canonical → 重建影子）是后续 P2，在同一个入口下扩展。

const DESKTOP_HELP = `用法：
  aih desktop status [--json]

说明：
  status  canonical 应用版本 / 影子副本 / 运行中实例 / 漂移结论
  --json  机器可读输出（供脚本或 WebUI 使用）`;

function parseDesktopArgs(argv = []) {
  const options = { action: '', json: false, help: false, unknown: [] };
  for (const token of argv) {
    const value = String(token || '').trim();
    if (!value) continue;
    if (value === '--json') { options.json = true; continue; }
    if (value === '--help' || value === '-h') { options.help = true; continue; }
    if (!options.action && !value.startsWith('-')) { options.action = value; continue; }
    options.unknown.push(value);
  }
  if (!options.action) options.action = 'status';
  return options;
}

function formatVersion(version) {
  return String(version || '').trim() || '未知';
}

function printTable(status, write) {
  const rows = status.apps.filter((app) => app.installed);
  if (rows.length === 0) {
    write('没有找到 aih 管理的桌面端应用（/Applications 与 ~/Applications）。');
    return;
  }
  const driftByKey = new Map(status.drift.map((item) => [item.key, item]));
  const table = rows.map((app) => {
    const shadows = status.shadows.filter((item) => item.key === app.key);
    const running = status.running.filter((item) => item.key === app.key);
    const drift = driftByKey.get(app.key);
    return [
      app.key,
      formatVersion(app.version),
      shadows.length === 0
        ? '—'
        : shadows.map((item) => formatVersion(item.version) + ' ' + item.fingerprint.slice(0, 8)).join(', '),
      running.length === 0
        ? '未运行'
        : running.map((item) => formatVersion(item.version) + ' x' + item.count + ' ' + (item.source === 'shadow' ? '影子' : '本体')).join(', '),
      drift ? describeDrift(drift) : '一致'
    ];
  });
  const header = ['应用', 'canonical', '影子副本', '运行中', '结论'];
  // 列宽按内容自适应：影子/运行中两列长度随版本号和指纹变化，写死会串列。
  const widths = header.map((title, index) => Math.max(
    displayWidth(title),
    ...table.map((row) => displayWidth(row[index]))
  ));
  const render = (row) => row.map((cell, index) => padCell(cell, widths[index], index === row.length - 1)).join(' ');
  write(render(header));
  for (const row of table) write(render(row));
  write('');
  write('提示：升级只影响 canonical；影子副本按指纹重建。旧影子等 7 天自动回收，或后续 `aih desktop gc`。');
}

// 中文按 2 列宽计算，否则表格会歪。
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/.test(char) ? 2 : 1;
  }
  return width;
}

function padCell(text, width, isLast) {
  if (isLast) return String(text);
  const pad = width - displayWidth(text);
  return String(text) + (pad > 0 ? ' '.repeat(pad) : '');
}

function describeDrift(drift) {
  const parts = [];
  if (drift.runningBehind.length > 0) {
    parts.push('运行中落后：' + drift.runningBehind.map((item) => item.version).join(', '));
  }
  if (drift.staleShadows.length > 0) {
    parts.push('旧影子 ' + drift.staleShadows.map((item) => item.version).join(', '));
  }
  return parts.join('；') || '一致';
}

function runDesktopCommand(argv = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const write = typeof deps.write === 'function' ? deps.write : (line) => consoleImpl.log(line);
  const options = parseDesktopArgs(argv);
  if (options.help || options.action === 'help') {
    write(DESKTOP_HELP);
    return 0;
  }
  if (options.unknown.length > 0) {
    consoleImpl.error('未知参数：' + options.unknown.join(' '));
    consoleImpl.error(DESKTOP_HELP);
    return 1;
  }
  if (options.action !== 'status') {
    consoleImpl.error('未知动作：' + options.action);
    consoleImpl.error(DESKTOP_HELP);
    return 1;
  }
  const status = collectDesktopStatus({
    fs: deps.fs || nodeFs,
    path: deps.path || nodePath,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    platform: deps.platform || process.platform,
    execFileSync: deps.execFileSync,
    listProcesses: deps.listProcesses
  });
  if (options.json) {
    write(JSON.stringify(status, null, 2));
    return 0;
  }
  printTable(status, write);
  return 0;
}

module.exports = { DESKTOP_HELP, formatVersion, parseDesktopArgs, printTable, runDesktopCommand };
