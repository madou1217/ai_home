'use strict';

// Windows psmux 下启动被 aih 接管的 codex（codex.cmd 里带 `aih-codex-cli-hook` 标记）。
//
// psmux pane 里跑 .cmd 会导致 pane 不可输入，persistent-launch 因此把 .cmd 解析成「node + 脚本」
// 直接启动。aih 自己的 codex 包装器也是 .cmd，旧的解析沿着它的 UPSTREAM 一路跟到原版
// codex.js，于是 aih 包装层（codex-app-server-stdio-proxy.js --run-cli-default / --run-cli-resume）
// 在 Windows 上整个被跳过：本地 app-server（终端 /resume 列全部会话）、启动前的会话路径修复等
// 只在 macOS/Linux 生效。这里按包装器自己的分派规则，直接用 node 启动包装层（node 进程，pane 可输入）。

const nodeFs = require('node:fs');

const WRAPPER_MARKER = 'aih-codex-cli-hook';
const ALIAS_WRAPPER_MARKER = 'aih-codex-cli-hook-alias';
// 与包装器 :AIH_FIND_SUBCOMMAND 跳过的带值选项一致。
const FLAGS_WITH_VALUE = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image',
  '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '-a', '--ask-for-approval'
]);

function findSubcommand(args) {
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '');
    if (token === '--') return '';
    if (FLAGS_WITH_VALUE.has(token.toLowerCase()) || FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return '';
}

function readSetVariable(body, name) {
  const match = String(body).match(new RegExp(`^\\s*set\\s+"${name}=([^"\\r\\n]*)"`, 'im'));
  return match ? match[1].trim() : '';
}

function readAliasTarget(body) {
  const match = String(body).match(/^\s*call\s+"([^"\r\n]+\.cmd)"\s+%\*/im);
  return match ? match[1].trim() : '';
}

/**
 * @returns {null | {command: string, args: string[], hookPath: string}}
 */
function resolveWindowsCodexHookLaunch(cliBin, args, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const fsImpl = options.fsImpl || nodeFs;
  let hookPath = String(cliBin || '').trim();
  for (let depth = 0; depth < 3 && hookPath; depth += 1) {
    if (!/\.(cmd|bat)$/i.test(hookPath)) return null;
    let body = '';
    try {
      if (!fsImpl.existsSync(hookPath)) return null;
      body = fsImpl.readFileSync(hookPath, 'utf8');
    } catch (_error) {
      return null;
    }
    if (body.includes(ALIAS_WRAPPER_MARKER)) {
      hookPath = readAliasTarget(body);
      continue;
    }
    if (!body.includes(WRAPPER_MARKER)) return null;

    const helper = readSetVariable(body, 'HELPER');
    const upstream = readSetVariable(body, 'UPSTREAM');
    const stateFile = readSetVariable(body, 'STATE_FILE');
    if (!helper || !upstream || !stateFile || !fsImpl.existsSync(helper)) return null;
    const configuredNode = readSetVariable(body, 'NODE_BIN');
    const nodeBin = configuredNode && fsImpl.existsSync(configuredNode)
      ? configuredNode
      : String(options.nodeExecPath || process.execPath);

    const subcommand = findSubcommand(args).toLowerCase();
    // app-server 维持原有启动方式（它有自己的穿透开关）。
    if (subcommand === 'app-server') return null;
    const mode = subcommand === 'resume' ? '--run-cli-resume' : '--run-cli-default';
    return {
      command: nodeBin,
      args: [
        helper, mode, '--upstream', upstream, '--state-file', stateFile, '--',
        ...(Array.isArray(args) ? args.map((value) => String(value)) : [])
      ],
      hookPath
    };
  }
  return null;
}

module.exports = { resolveWindowsCodexHookLaunch, findSubcommand };
