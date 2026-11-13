#!/usr/bin/env node

const { markAccountAppProcess } = require('../lib/runtime/account-app-process-marker');

markAccountAppProcess(process);

// TUI 靠绝对行号重绘：任何写到 stderr 的杂音都会让整屏串行（见注释）。
require('../lib/runtime/sqlite-warning-filter').installSqliteWarningFilter(process);

// 终端集成（TAB 补全 / 拼写建议）走**轻量路径**：完整 CLI 组合根要装配所有命令（实测约 1.3s），
// 而补全必须在一百毫秒内出结果。除这几个内部动词之外的一切照旧走 lib/cli/app。
const INTERNAL_FAST_PATH_VERBS = new Set(['__complete', '__suggest', '__learn']);

// `aih ss --list` / `--detail` 也走轻量路径：完整 CLI 组合根约 2s，而纯列表
// 只需要持久会话注册表。只在注册表里已经有会话时生效 —— 注册表为空时可能是重启后
// 需要 restore，那种情况交回完整 CLI（它会做懒恢复）。
//
// 交互选择器与 `aih ss <名字>` 必须走完整 CLI：真正进入会话需要 PTY 运行时
// （runCliPty 只在组合根里装配），快路径拿不到它，Enter 只会报
// 「PTY runtime is unavailable」（2026-11-06 用户多次遇到）。
// aih ss|sessions --list/--detail 固定走 Go：只读注册表 + tmux 探测，不装配 Node
// 组合根；交互 picker / --refresh（Node 标题缓存）与按名字进入仍交回 Node。
const GLOBAL_SESSION_DETAIL_TOKENS = new Set([
  '--list', '-l', '--detail', '--details', '--verbose', '-v', '-vv', '-vvv',
  'list', 'detail', 'details', 'vvv'
]);

function tryRunGoGlobalSessions() {
  const args = process.argv.slice(2);
  const verb = String(args[0] || '').trim().toLowerCase();
  if (verb !== 'ss' && verb !== 'sessions') return false;
  // 裸 aih ss：TTY 下 Go 交互选择器，非 TTY 直接输出分组列表。
  if (args.length === 1) return runGoGlobalSessions(args);
  if (args.length !== 2) return false;
  const token = String(args[1] || '').trim();
  const isDetail = GLOBAL_SESSION_DETAIL_TOKENS.has(token);
  // aih ss <名字>：直接进入指定会话（Go 负责匹配与 attach）。
  const isTarget = args.length === 2 && /^[^-]/.test(token) && token !== '';
  const isRefresh = token === '--refresh' || token === '-r';
  if (!isDetail && !isTarget && !isRefresh) return false;
  return runGoGlobalSessions(args);
}

// runGoGlobalSessions 把已校验的 aih ss 参数交给 Go CLI。
function runGoGlobalSessions(args) {
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  if (aiHomeDir) env.AIH_HOME_DIR = aiHomeDir;
  if (managementKey) {
    env.AIH_SERVER_BASE_URL = 'http://127.0.0.1:19550';
    env.AIH_SERVER_MANAGEMENT_KEY = managementKey;
  }
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

function tryPersistentSessionFastPath() {
  const verb = process.argv[2];
  if (verb !== 'ss' && verb !== 'sessions') return false;
  const rest = process.argv.slice(3);
  if (rest.some((token) => token === '--help' || token === '-h' || token === 'help')) return false;
  try {
    const {
      isGlobalSessionListOnlyRequest,
      runGlobalPersistentSessionsCommand
    } = require('../lib/cli/services/ai-cli/persistent-session-list');
    if (!isGlobalSessionListOnlyRequest(rest)) return false;
    const { resolveAiHomeDir } = require('../lib/runtime/aih-home');
    const { resolveUnprojectedHostHomeDir } = require('../lib/runtime/host-home');
    // 在会话里（HOME 是账号投影）也要看到宿主的会话：shell drawer 里跑 aih ss 是常见用法。
    const aiHomeDir = resolveAiHomeDir({
      env: process.env,
      hostHomeDir: resolveUnprojectedHostHomeDir({ env: process.env })
    });
    if (!aiHomeDir) return false;
    const entries = require('../lib/runtime/persistent-session-registry').listEntries(aiHomeDir, {});
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const result = runGlobalPersistentSessionsCommand(rest, {
      aiHomeDir,
      processImpl: process,
      fs: require('node:fs'),
      consoleImpl: console
    });
    Promise.resolve(result).then(
      (code) => {
        process.exitCode = Number.isInteger(code) ? code : 0;
        // 一次性命令：别被残留的 stdin 句柄挂住（picker 自己会放掉，这里再兜一层）。
        try {
          if (process.stdin && typeof process.stdin.unref === 'function') process.stdin.unref();
        } catch (_error) { /* 忽略 */ }
      },
      (error) => {
        process.stderr.write(`[aih] sessions failed: ${(error && error.message) || error}\n`);
        process.exitCode = 1;
      }
    );
    return true;
  } catch (_error) {
    return false;
  }
}

// `aih ls` / `aih <provider> ls` 同样走轻量路径：列表第一帧只依赖账号索引，
// 没必要为了它装配 server / webui / chat-runtime 全套（实测组合根 1.3s 起步）。
// 任何异常都返回 false，交回完整 CLI 兜底。
// aih ls [id] [--scope <provider...>] 固定走 Go：全量账号列表只依赖 Management API。
// 带 provider 选择器（子串/通配）或 --help 的形态仍交回 Node 的完整解析。
function tryRunGoGlobalLs() {
  const args = process.argv.slice(2);
  if (args.length < 1) return false;
  if (String(args[0] || '').trim().toLowerCase() !== 'ls') return false;
  const rest = args.slice(1);
  if (rest.some((token) => token === '--help' || token === '-h' || token === 'help')) return false;
  let ids = 0;
  let scopeCount = 0;
  let expectingScope = false;
  for (const token of rest) {
    if (token === '--scope') {
      if (expectingScope) return false;
      expectingScope = true;
      continue;
    }
    if (expectingScope) {
      if (token.startsWith('-')) return false;
      scopeCount += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      ids += 1;
      if (ids > 1) return false;
      continue;
    }
    return false;
  }
  if (expectingScope && scopeCount === 0) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih codex set-mobile|unset-mobile 固定走 Go：服务端写 desktop-hook-state.json。
function tryRunGoCodexMobile() {
  const args = process.argv.slice(2);
  if (args.length < 2) return false;
  if (String(args[0] || '').trim().toLowerCase() !== 'codex') return false;
  const verb = String(args[1] || '').trim().toLowerCase();
  if (verb !== 'set-mobile' && verb !== 'unset-mobile') return false;
  if (verb === 'set-mobile' && (args.length !== 3 || !/^\d+$/.test(String(args[2] || '').trim()))) return false;
  if (verb === 'unset-mobile' && args.length !== 2) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih codex policy [show|set <sandbox>] 固定走 Go：读写 app-state 的 policy:exec。
function tryRunGoCodexPolicy() {
  const args = process.argv.slice(2);
  if (args.length < 2) return false;
  if (String(args[0] || '').trim().toLowerCase() !== 'codex') return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'policy') return false;
  const rest = args.slice(2).map((token) => String(token || '').trim()).filter(Boolean);
  let valid = false;
  if (rest.length === 0) valid = true;
  else if (rest.length === 1 && rest[0].toLowerCase() === 'show') valid = true;
  else if (rest.length === 2 && rest[0].toLowerCase() === 'set') valid = true;
  if (!valid) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  const env = { ...process.env, AIH_HOME_DIR: aiHomeDir };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih codex home [id] 固定走 Go：按 codex 投影策略渲染伪 CODEX_HOME/auth 路径。
function tryRunGoCodexHome() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) return false;
  if (String(args[0] || '').trim().toLowerCase() !== 'codex') return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'home') return false;
  if (args.length === 3 && !/^\d+$/.test(String(args[2] || '').trim())) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih claude version 固定走 Go：解析官方 CLI 并输出首行版本与路径。
function tryRunGoProviderVersion() {
  const args = process.argv.slice(2);
  if (args.length !== 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  // codex 的 PATH 入口在本机是旧 Node hook，Go 侧按安全策略拒绝执行它；
  // 只接管 claude，codex 仍由 Node 解析可执行文件。
  if (provider !== 'claude') return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'version') return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih codex sessions --history 固定走 Go：读 rollout 索引（id/cwd/标题/时间）。
function tryRunGoCodexSessionsHistory() {
  const args = process.argv.slice(2);
  if (args.length < 3) return false;
  if (String(args[0] || '').trim().toLowerCase() !== 'codex') return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'sessions') return false;
  const rest = args.slice(2);
  if (!rest.includes('--history')) return false;
  const allowed = rest.every((token) => (
    token === '--history' || token === '--limit' || token === '-n' || /^\d+$/.test(token)
  ));
  if (!allowed) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// 非 TTY 下的 aih <codex|claude> ls [id] 固定走 Go：静态表格即可，交互动画仍交 Node。
function tryRunGoProviderLs() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (provider !== 'codex' && provider !== 'claude') return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'ls') return false;
  if (args.length === 3 && !/^\d+$/.test(String(args[2] || '').trim())) return false;
  if (process.stdout.isTTY) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

function tryLsFastPath() {
  try {
    const { tryRunLsFastPath } = require('../lib/cli/services/profile/ls-fastpath');
    return tryRunLsFastPath({ processObj: process, argv: process.argv });
  } catch (_error) {
    return false;
  }
}

// CodeBuddy / WorkBuddy 家族裸启动（只有 provider + 数字账号）固定走 Go CLI：
// Go 侧已有 fake-home 投影、共享 .info 物化与退出捕获。Go 二进制缺失时明确报错，
// 不悄悄回退 Node —— 回退会让同一账号在两套投影语义之间切换。
const GO_FAMILY_PROVIDERS = new Set(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);

function resolveGoCLIBinary() {
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  return path.join(
    root,
    'bin',
    'native',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'aih-go.exe' : 'aih-go'
  );
}

// applyGoFamilyEgressGuard 把 Node 的账号出口绑定语义带到 Go 启动路径：
// Go CLI 还没有账号级出口代理，url/pool/system/retired 返回 false 交回 Node；
// direct 表示绕过任何代理，显式清空代理变量并 NO_PROXY=*（与 Node 语义一致）。
function applyGoFamilyEgressGuard(env, fs, aiHomeDir, provider, accountToken) {
  try {
    const { resolveAccountRefByCliId } = require('../lib/server/account-ref-store');
    const account = resolveAccountRefByCliId(fs, aiHomeDir, provider, accountToken, { bestEffort: true });
    if (!account) return false;
    const { listAccountEgressBindings } = require('../lib/account/zcode-egress-binding-store');
    const entries = listAccountEgressBindings(fs, aiHomeDir);
    const binding = entries.find((entry) => entry && entry.accountRef === account.accountRef);
    const record = binding && binding.binding;
    const mode = String(record && record.mode || '').trim().toLowerCase();
    if (record && (record.retired || ['url', 'pool', 'system'].includes(mode))) {
      return false;
    }
    if (mode === 'direct') {
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        delete env[key];
      }
      env.NO_PROXY = '*';
      env.no_proxy = '*';
    }
    return true;
  } catch (_error) {
    return false;
  }
}

// 家族保留动作：出现在账号位之后时由各自的 Go 转发器处理，不能当成原生参数。
const GO_FAMILY_RESERVED_ACTIONS = new Set([
  'resume', 'fork', 'sessions', 'usage', 'ls', 'login', 'home', 'version', 'detect',
  'auto-switch', 'set-default', 'unset-default', 'delete', 'deleteall', 'delete-all',
  'terminal-icon', 'terminal-icons', 'help', '--help', '-h'
]);

// aih <family> <id> --restart-client 固定走 Go：Management API close + open 桌面端。
function tryRunGoFamilyRestart() {
  const args = process.argv.slice(2);
  if (args.length < 3) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  if (!/^\d+$/.test(String(args[1] || '').trim())) return false;
  const hasFlag = args.slice(2).some((token) => token === '--restart-client' || token === '--force-quit-client');
  if (!hasFlag) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write('[aih] Go CLI 未构建：' + binary + '\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n');
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

function tryRunGoFamilyLaunch() {
  const args = process.argv.slice(2);
  if (args.length < 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  if (!/^\d+$/.test(String(args[1] || '').trim())) return false;
  if (args.length >= 3 &&
    GO_FAMILY_RESERVED_ACTIONS.has(String(args[2] || '').trim().toLowerCase())) {
    return false;
  }
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  if (aiHomeDir) env.AIH_HOME_DIR = aiHomeDir;
  if (aiHomeDir && !applyGoFamilyEgressGuard(env, fs, aiHomeDir, provider, args[1])) {
    return false;
  }
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih <family> [<账号>] resume|fork ... 固定走 Go：翻译成官方 --resume/--continue，
// 复用 Go CLI 的账号投影启动路径（会话 projects 已链接回宿主）。
const GO_FAMILY_SESSION_VERBS = new Set(['resume', 'fork']);

function tryRunGoFamilySessionVerb() {
  const args = process.argv.slice(2);
  if (args.length < 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  const verbIndex = GO_FAMILY_SESSION_VERBS.has(String(args[1] || '').trim().toLowerCase())
    ? 1
    : (args.length >= 3
      && !String(args[1]).startsWith('-')
      && GO_FAMILY_SESSION_VERBS.has(String(args[2] || '').trim().toLowerCase())
      ? 2
      : -1);
  if (verbIndex < 0) return false;
  // --help 留给统一用法文案（Node 侧维护），其余参数原样交给 Go。
  if (args.some((token) => token === '--help' || token === '-h')) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  if (aiHomeDir) env.AIH_HOME_DIR = aiHomeDir;
  if (managementKey) {
    env.AIH_SERVER_BASE_URL = 'http://127.0.0.1:19550';
    env.AIH_SERVER_MANAGEMENT_KEY = managementKey;
  }
  if (verbIndex === 2 && aiHomeDir
    && !applyGoFamilyEgressGuard(env, fs, aiHomeDir, provider, args[1])) {
    return false;
  }
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih <family> sessions --history 固定走 Go：sessionscan/codebuddy 只读宿主 JSONL。
function tryRunGoFamilySessions() {
  const args = process.argv.slice(2);
  if (args.length < 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'sessions') return false;
  const rest = args.slice(2);
  let allowed = false;
  if (rest.includes('--history')) {
    allowed = rest.every((token) => (
      token === '--history' || token === '--limit' || token === '-n' || /^\d+$/.test(token)
    ));
  } else {
    // 持久会话列表：sessions [id] [--all-projects]
    const ids = rest.filter((token) => /^\d+$/.test(token));
    allowed = ids.length <= 1 && rest.every((token) => (
      token === '--all-projects' || /^\d+$/.test(token)
    ));
  }
  if (!allowed) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  const env = { ...process.env };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  if (managementKey) {
    env.AIH_SERVER_BASE_URL = 'http://127.0.0.1:19550';
    env.AIH_SERVER_MANAGEMENT_KEY = managementKey;
  }
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih <family> login 固定走 Go：临时 fake-home 投影 + PTY 官方 CLI 登录，
// 退出后由 Go 读取 .info 并注册账号；不经过 Node 登录 Job。
function tryRunGoFamilyLogin() {
  const args = process.argv.slice(2);
  if (args.length !== 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  if (String(args[1] || '').trim().toLowerCase() !== 'login') return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  const env = { ...process.env, AIH_HOME_DIR: aiHomeDir };
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

// aih <family> ls / usage [<id> [--refresh]] / home / version 也固定走 Go：
// 账号列表、额度读取与本地投影诊断都由 Go 承担，Node 只注入 Server 地址与 Key。
function tryRunGoFamilyServerCommand() {
  const args = process.argv.slice(2);
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  const command = String(args[1] || '').trim().toLowerCase();
  const isList = command === 'ls' &&
    (args.length === 2 || (args.length === 3 && /^\d+$/.test(String(args[2] || '').trim())));
  const isUsage = (args.length === 2 && command === 'usage') ||
    (args.length === 3 && command === 'usage' && args[2] === '--refresh') ||
    ((args.length === 3 || args.length === 4) &&
      command === 'usage' &&
      /^\d+$/.test(String(args[2] || '').trim()) &&
      (args.length === 3 || args[3] === '--refresh'));
  const isSetDefault = args.length === 3 && command === 'set-default' &&
    /^\d+$/.test(String(args[2] || '').trim());
  const isUnsetDefault = args.length === 2 && command === 'unset-default';
  const isHome = (args.length === 2 && command === 'home') ||
    (args.length === 3 && command === 'home' && /^\d+$/.test(String(args[2] || '').trim()));
  const isHomeAfterId = args.length === 3 &&
    /^\d+$/.test(String(args[1] || '').trim()) &&
    String(args[2] || '').trim().toLowerCase() === 'home';
  const isVersion = args.length === 2 && command === 'version';
  const isAutoSwitch = command === 'auto-switch' && args.length >= 2 && args.length <= 5;
  const isDelete = command === 'delete' && args.length >= 3;
  const isDeleteAll = (command === 'deleteall' || command === 'delete-all') && args.length === 2;
  const isDetect = command === 'detect' && args.length === 2;
  const isHelp = args.length === 2 &&
    (command === 'help' || command === '--help' || command === '-h');
  // 终端图标安装是本地命令：图标从 Go 二进制内嵌资产物化，不访问 Server。
  const isTerminalIcon = (command === 'terminal-icon' || command === 'terminal-icons') &&
    args.length >= 2;
  const needsServer = isList || isUsage || isSetDefault || isUnsetDefault || isAutoSwitch ||
    isDelete || isDeleteAll || isDetect;
  if (!needsServer && !isHome && !isHomeAfterId && !isVersion && !isHelp && !isTerminalIcon) return false;
  const fs = require('node:fs');
  const os = require('node:os');
  const binary = resolveGoCLIBinary();
  if (!fs.existsSync(binary)) {
    process.stderr.write(`[aih] Go CLI 未构建：${binary}\n[aih] 运行 npm run go:build 后再试；不会回落 Node。\n`);
    process.exitCode = 1;
    return true;
  }
  let hostHome = '';
  try {
    hostHome = require('../lib/runtime/host-home').resolveUnprojectedHostHomeDir({ env: process.env, os });
  } catch (_error) {
    hostHome = '';
  }
  let aiHomeDir = String(process.env.AIH_HOME_DIR || '').trim();
  if (!aiHomeDir) {
    try {
      aiHomeDir = require('../lib/runtime/aih-home').resolveAiHomeDir({ env: process.env, hostHomeDir: hostHome });
    } catch (_error) {
      aiHomeDir = '';
    }
  }
  if (!aiHomeDir) return false;
  let config = null;
  try {
    config = require('../lib/server/server-config-store').readServerConfig({ fs, aiHomeDir });
  } catch (_error) {
    config = null;
  }
  const managementKey = String(config && config.managementKey || '').trim();
  if (needsServer && !managementKey) return false;
  const env = { ...process.env, AIH_HOME_DIR: aiHomeDir };
  if (managementKey) {
    // Go Server 的账号管理面在本地 Go Core 端口；9527 是客户端 API 前门，
    // /v1/management 不在这条公开路由上。
    env.AIH_SERVER_BASE_URL = 'http://127.0.0.1:19550';
    env.AIH_SERVER_MANAGEMENT_KEY = managementKey;
  }
  if (hostHome) env.AIH_HOST_HOME = hostHome;
  const result = require('node:child_process').spawnSync(binary, args, { stdio: 'inherit', env });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  return true;
}

const fastPathVerb = process.argv[2];
if (INTERNAL_FAST_PATH_VERBS.has(fastPathVerb)) {
  const complete = require('../lib/cli/complete');
  const entryArgv = process.argv.slice(3);
  const exitCode = fastPathVerb === '__complete'
    ? complete.runCompleteEntry(entryArgv)
    : (fastPathVerb === '__suggest'
      ? complete.runSuggestEntry(entryArgv)
      : complete.runLearnEntry(entryArgv));
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 0;
} else if (!tryRunGoFamilySessionVerb() && !tryRunGoFamilySessions() && !tryRunGoFamilyLogin() && !tryRunGoFamilyServerCommand() && !tryRunGoFamilyRestart() && !tryRunGoFamilyLaunch() && !tryRunGoGlobalSessions() && !tryRunGoGlobalLs() && !tryRunGoCodexMobile() && !tryRunGoCodexPolicy() && !tryRunGoCodexHome() && !tryRunGoProviderVersion() && !tryRunGoCodexSessionsHistory() && !tryRunGoProviderLs() && !tryLsFastPath() && !tryPersistentSessionFastPath()) {
  require('../lib/cli/app');
}
