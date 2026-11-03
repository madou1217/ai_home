'use strict';

// Windows cmd.exe 启动封装：全仓库唯一持有「libuv spawn 转义 vs cmd.exe
// 解析」这条平台知识的模块。
//
// 背景（2026-08-22 WebUI 点击 CLI 图标无声失败事故）：child_process.spawn 按
// MSVCRT 规则给含引号的 argv 元素包一层外引号、并把内部 " 转义成 \"；而
// cmd.exe 不认识 \"（/c、/k 按 /s 规则只剥首尾引号），残留的 \" 会让 start
// 永久挂起、目标命令永不执行。因此「用 cmd.exe 执行一整段命令字符串」的
// spawn 必须使用本模块产出的规格：args 已按 `/d /s /c "…"` 惯用法拼好，并
// 声明 windowsVerbatimArguments 由 spawner 关闭 libuv 转义。
//
// 边界：node-pty（pty-launch.js）与 WT profile（terminal-icons.js）消费的是
// 原始命令行字符串、不经过 libuv argv 转义，不需要（也不应）使用本模块。

const CMD_EXE = 'cmd.exe';

// escapeCmdTitle 只处理标题里的 "；标题由调用方保证不含 & | ^ 等命令分隔符。
function escapeCmdTitle(value) {
  return String(value || '').replace(/"/g, "'");
}

// buildWindowsCmdLaunch 构造通过 cmd.exe 执行命令字符串的 spawn 规格。
// - 默认（inline）：`cmd /d /s /c "<command>"`，命令在当前控制台执行后退出。
// - newConsole：`cmd /d /s /c start "<title>" cmd /d /s /k "<command>"`，
//   由 start 新开一个可见控制台窗口（Win10/11 按系统默认终端应用承载），
//   命令整链（含 set A && set B && <cli>）都在该窗口内执行，不会在外层
//   cmd 的 && 处被拆到隐藏控制台。
function buildWindowsCmdLaunch(command, options = {}) {
  const commandText = String(command || '');
  const line = options.newConsole
    ? `start "${escapeCmdTitle(options.title)}" ${CMD_EXE} /d /s /k "${commandText}"`
    : `"${commandText}"`;
  return {
    file: CMD_EXE,
    args: ['/d', '/s', '/c', line],
    windowsVerbatimArguments: true
  };
}

// windowsSpawnOptions 从启动规格提取 Windows spawn 选项；规格未声明时缺省为
// 关闭（即走 libuv 转义的标准路径）。posix 平台会忽略该选项，可无条件合并。
function windowsSpawnOptions(launch) {
  return {
    windowsVerbatimArguments: Boolean(launch && launch.windowsVerbatimArguments)
  };
}

// requiresCmdShell 回答另一个方向的同一个问题：spawn 一个 .cmd/.bat **本身**该怎么办。
//
// Node 18.20 / 20.12 起（CVE-2024-27980 的缓解）：child_process.spawn / spawnSync 一个
// .cmd 或 .bat 且不带 shell 时直接抛 EINVAL —— 不是命令失败，是根本没启动。
// 实测 2026-09-14，Windows（node v22.23.1）：
//   spawnSync('npm.cmd', ['root','-g'])                 → error EINVAL，stdout 空
//   spawnSync('npm.cmd', ['root','-g'], {shell: true})  → stdout "d:\nvm4w\nodejs\node_modules"
//
// 这条在读路径上尤其阴险：查询失败往往被上层当作「没有新版」静静吞掉，于是整套自动
// 升级在 Windows 上变成一块永远绿着的仪表盘。所有 spawn npm.cmd 的地方都必须过这里。
//
// 只在 win32 且命令确实以 .cmd/.bat 结尾时才开 shell：shell 会把 argv 拼成一行交给
// cmd.exe，多开一次就多一份注入面，POSIX 上更是完全没有必要。
function requiresCmdShell(command, platform) {
  if (String(platform || '') !== 'win32') return false;
  return /\.(?:cmd|bat)$/i.test(String(command || ''));
}

module.exports = {
  buildWindowsCmdLaunch,
  windowsSpawnOptions,
  requiresCmdShell
};
