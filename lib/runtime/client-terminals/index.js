'use strict';

const cmd = require('./cmd');
const iterm2 = require('./iterm2');
const systemDefault = require('./system-default');
const warp = require('./warp');
const wezterm = require('./wezterm');
const windowsTerminal = require('./windows-terminal');

/**
 * 终端插件注册表（显式数组，顺序即非 Windows 平台的展示顺序）。
 *
 * 插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability / order）：
 * - id / name / description / sourceUrl / capability='toolkit.terminal'
 * - platforms: 支持的平台（数据，不是函数），注册表按它过滤
 * - executables?: { [platform]: { binaryNames, managedPaths, paths } } 探测位置
 * - detect(context) / buildLaunch(command, title, context)
 * - lifecycle?: { [platform]: (context, deps) => plans } 安装/更新/卸载计划
 * - windowsOrder?: Windows 下的展示顺序；hiddenOnPlatforms?: 在这些平台不进列表
 *
 * 新增终端 = 新增一个插件文件并登记到此数组。
 */
const TERMINAL_PLUGINS = Object.freeze([systemDefault, wezterm, warp, iterm2, windowsTerminal, cmd]);

module.exports = {
  TERMINAL_PLUGINS
};
