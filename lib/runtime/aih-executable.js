'use strict';

const path = require('node:path');

/**
 * 分发包（便携版 / 单文件）会在启动器里设置 AIH_EXECUTABLE。
 * 它和 `process.argv[1]` 的区别很关键：argv[1] 是 bin/ai-home.js，
 * 需要外部 PATH 上恰好有 node；AIH_EXECUTABLE 是可被直接 spawn 的启动器。
 *
 * 终端集成、zcode 协议处理器和后台自启都要求后者。
 */
function nonEmpty(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveAihExecutable(options = {}) {
  const env = options.env || process.env;
  return nonEmpty(env.AIH_EXECUTABLE) || nonEmpty(env.AIH_CLI_PATH);
}

function resolveAihEntryFile(options = {}) {
  const processObj = options.processObj || process;
  const entry = nonEmpty(processObj.argv && processObj.argv[1]);
  if (entry) return entry;
  return path.resolve(__dirname, '..', '..', 'bin', 'ai-home.js');
}

/**
 * 构造一次「重新调用 aih」的 spawn 参数。
 * 打包态直接执行启动器；源码态保持 `node <bin/ai-home.js> ...` 的历史行为。
 */
function buildAihInvocation(args = [], options = {}) {
  const launcher = resolveAihExecutable(options);
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  if (launcher) {
    return { command: launcher, args: list, packaged: true };
  }
  const processObj = options.processObj || process;
  return {
    command: processObj.execPath || process.execPath,
    args: [resolveAihEntryFile({ processObj }), ...list],
    packaged: false
  };
}

module.exports = {
  buildAihInvocation,
  resolveAihEntryFile,
  resolveAihExecutable
};
