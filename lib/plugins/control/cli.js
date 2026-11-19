'use strict';

// `aih plugin <command>` 的唯一实现已迁到 Go CLI（cmd/aih/plugin.go）。
//
// Node 入口只做进程转交，避免保留第二套打包/签名/信任根/启停编排逻辑：
//   - 离线：validate / pack / keygen / trust / untrust / trusted
//   - 运行时：install / list / enable / disable / uninstall / call / doctor
//
// Go CLI 负责解析参数、读写信任根并调用 Go Server 的插件管理路由。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USAGE = [
  'Usage: aih plugin <command> [options]',
  '',
  '  validate / pack / keygen / trust / untrust / trusted',
  '  install / list / enable / disable / uninstall / call / doctor',
  '',
  '实现位于 Go CLI：cmd/aih/plugin.go'
].join('\n');

function resolveGoCLI() {
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const binaryName = process.platform === 'win32' ? 'aih-go.exe' : 'aih-go';
  return path.join(repositoryRoot, 'bin', 'native', `${process.platform}-${process.arch}`, binaryName);
}

async function runPluginCommand(rawArgs = [], context = {}) {
  const output = context.consoleImpl || console;
  const args = (Array.isArray(rawArgs) ? rawArgs.slice(1) : []).map(String);
  const binary = resolveGoCLI();
  if (!fs.existsSync(binary)) {
    output.error('\x1b[31m[aih] 原生 Go CLI 未构建；请运行 npm run go:build\x1b[0m');
    return 126;
  }
  const env = { ...process.env };
  if (context.aiHomeDir) env.AIH_HOME_DIR = String(context.aiHomeDir);
  if (context.managementKey) env.AIH_SERVER_MANAGEMENT_KEY = String(context.managementKey);
  const capture = Boolean(context.consoleImpl);
  const result = spawnSync(binary, ['plugin', ...args], {
    stdio: ['inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    env,
    encoding: 'utf8'
  });
  if (capture) {
    if (result.stdout) output.log(result.stdout.replace(/\n$/, ''));
    if (result.stderr) output.error(result.stderr.replace(/\n$/, ''));
  }
  if (result.error) {
    output.error(`\x1b[31m[aih] plugin 启动 Go CLI 失败：${result.error.message}\x1b[0m`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

module.exports = { runPluginCommand, USAGE };