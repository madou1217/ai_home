'use strict';

const { spawnSync } = require('node:child_process');

// 系统代理插件共用的命令执行：可注入 execCommand / spawnSync，便于测试与远端执行。
function runCommand(options, command, args = []) {
  if (typeof options.execCommand === 'function') return options.execCommand(command, args);
  try {
    return options.spawnSync
      ? options.spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  } catch (error) {
    return { status: null, stdout: '', stderr: error.message };
  }
}

function output(result) {
  return String(result?.stdout || '');
}

function succeeded(result) {
  return result?.status === 0 || result?.ok === true;
}

// 读取系统代理设置失败时区分「平台没有这个工具」与「工具执行出错」。
function probeFailureStatus(result) {
  if (result.status === 127 || /not found|not recognized|enoent/i.test(result.stderr)) return 'unsupported';
  return 'error';
}

module.exports = {
  output,
  probeFailureStatus,
  runCommand,
  succeeded
};
