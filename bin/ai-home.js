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

function tryRunGoFamilyLaunch() {
  const args = process.argv.slice(2);
  if (args.length !== 2) return false;
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  if (!/^\d+$/.test(String(args[1] || '').trim())) return false;
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
  // 出口守卫：Go CLI 还没有账号级出口代理。url/pool/system/retired 账号交回 Node；
  // direct 在 Node 侧是「绕过任何代理」，这里显式清代理并 NO_PROXY=*，语义一致。
  if (aiHomeDir) {
    try {
      const { resolveAccountRefByCliId } = require('../lib/server/account-ref-store');
      const account = resolveAccountRefByCliId(fs, aiHomeDir, provider, args[1], { bestEffort: true });
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
    } catch (_error) {
      return false;
    }
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

// aih <family> ls / usage [<id> [--refresh]] 也固定走 Go：账号列表、额度读取与
// 刷新由 Go Server 承担，Node 只注入 Server 地址与 Management Key。
function tryRunGoFamilyServerCommand() {
  const args = process.argv.slice(2);
  const provider = String(args[0] || '').trim().toLowerCase();
  if (!GO_FAMILY_PROVIDERS.has(provider)) return false;
  const command = String(args[1] || '').trim().toLowerCase();
  const isList = args.length === 2 && command === 'ls';
  const isUsage = (args.length === 3 || args.length === 4) &&
    command === 'usage' &&
    /^\d+$/.test(String(args[2] || '').trim()) &&
    (args.length === 3 || args[3] === '--refresh');
  if (!isList && !isUsage) return false;
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
  if (!managementKey) return false;
  const env = {
    ...process.env,
    AIH_HOME_DIR: aiHomeDir,
    // Go Server 的账号管理面在本地 Go Core 端口；9527 是客户端 API 前门，
    // /v1/management 不在这条公开路由上。
    AIH_SERVER_BASE_URL: 'http://127.0.0.1:19550',
    AIH_SERVER_MANAGEMENT_KEY: managementKey
  };
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
} else if (!tryRunGoFamilyLogin() && !tryRunGoFamilyServerCommand() && !tryRunGoFamilyLaunch() && !tryLsFastPath() && !tryPersistentSessionFastPath()) {
  require('../lib/cli/app');
}
