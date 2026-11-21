'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 分发包（便携版 / 单文件）会在启动器里设置 AIH_EXECUTABLE；它是最优先的可执行入口。
 * 源码态直接使用已构建的 Go CLI，不再回退到 node bin/ai-home.js：
 * 回退会让“同一台机器两套入口”长期并存，调用方也无法判断拿到的是哪一套。
 */
function nonEmpty(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function resolveAihExecutable(options = {}) {
  const env = options.env || process.env;
  return nonEmpty(env.AIH_EXECUTABLE);
}

function resolveAihBinary(options = {}) {
  const launcher = resolveAihExecutable(options);
  if (launcher) return launcher;
  const platform = nonEmpty(options.platform) || process.platform;
  const arch = nonEmpty(options.arch) || process.arch;
  const name = platform === 'win32' ? 'aih-go.exe' : 'aih-go';
  const binary = path.resolve(__dirname, '..', '..', 'bin', 'native', `${platform}-${arch}`, name);
  if (!fs.existsSync(binary)) {
    throw new Error(`[aih] Go CLI 未构建：${binary}（先运行 npm run go:build）`);
  }
  return binary;
}

/**
 * 构造一次「重新调用 aih」的 spawn 参数：统一返回可直接执行的 Go 入口。
 * packaged 只表示路径来自 AIH_EXECUTABLE（打包启动器），供调用方展示。
 */
function buildAihInvocation(args = [], options = {}) {
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  return {
    command: resolveAihBinary(options),
    args: list,
    packaged: Boolean(resolveAihExecutable(options))
  };
}

module.exports = {
  buildAihInvocation,
  resolveAihBinary,
  resolveAihExecutable
};
