'use strict';

// webUI native run 的多路复用执行层（tmux / herdr）：让 CLI 进程的生命周期与 server 进程彻底脱钩。
//
// 设计：**每个 run 一个独立 socket / namespace**（aih-run-<runId 前缀>）。
// 理由：webUI 并发 run 来自不同 provider/账号，env（凭据）互不相同，
// 独立 socket/namespace = 每 run 自带正确 env、互不污染；abort = kill 一锅端无殃及；
// has-session 判活也最简单。
//
// systemd 逃逸：aih-server 作为 systemd user service 跑时（AWS），由底层的 MultiplexerDriver
// 统一处理 systemd-run --user --scope 逃逸，restart 时不波及任务。

const { spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const path = require('node:path');
const {
  RUN_EXIT_MARKER,
  RUN_SESSION_NAME,
  resolveMultiplexerDriver,
  defaultTmuxDriver
} = require('../runtime/multiplexer');

function quote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

function isTmuxRunSupported(options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  const detected = driver.detect(options);
  return detected && detected.available === true;
}

function isSystemdScopeSupported(options = {}) {
  return defaultTmuxDriver.isSystemdScopeSupported(options);
}

function socketForRun(runId) {
  const compact = String(runId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'unknown';
  return `aih-run-${compact}`;
}

// 组装在 pane 里执行的 shell 命令：整体（含管道,如 claude 图片 cat-pipe）重定向到日志,
// 结束后追加退出标记行——tail 端据此确定性拿到完成信号与退出码,无需轮询进程。
function buildRunShellCommand(innerShellCommand, logPath) {
  const qlog = quote(logPath);
  return `{ ${innerShellCommand} ; } > ${qlog} 2>&1; printf '\\n${RUN_EXIT_MARKER}%s\\n' "$?" >> ${qlog}`;
}

// argv 数组 → 单条安全 shell 命令（无管道的常规 CLI 调用用它;claude 图片分支自带 sh 命令串）。
function buildInnerCommandFromArgv(command, args = []) {
  return [command, ...args].map(quote).join(' ');
}

function spawnDetachedTmuxRun(options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  return driver.spawnHeadlessRun(options);
}

function hasRunSession(socket, options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  return driver.hasRun(socket, options);
}

function killRunServer(socket, options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  return driver.killRun(socket, options);
}

function runSocketPath(socket, options = {}) {
  return defaultTmuxDriver.runSocketPath(socket, options);
}

function cleanupRunSocket(socket, options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  return driver.cleanupRun(socket, options);
}

function sendRunKeys(socket, text, options = {}) {
  const driver = options.driver || resolveMultiplexerDriver(options);
  return driver.sendInput(socket, text, options);
}

module.exports = {
  RUN_EXIT_MARKER,
  RUN_SESSION_NAME,
  isTmuxRunSupported,
  isSystemdScopeSupported,
  socketForRun,
  buildRunShellCommand,
  buildInnerCommandFromArgv,
  spawnDetachedTmuxRun,
  hasRunSession,
  killRunServer,
  cleanupRunSocket,
  sendRunKeys
};
