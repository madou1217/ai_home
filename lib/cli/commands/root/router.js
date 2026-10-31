'use strict';

const { normalizeRootCommandArgs } = require('./args');
const { exitAfterFlush } = require('../../../runtime/exit-after-flush');
const { listSupportedAiClis } = require('../../services/ai-cli/provider-registry');
const { listCliAccountRefRecords } = require('../../../server/account-ref-store');

function isHelpCommand(cmd) {
  return !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h';
}

function isSupportedCliName(cmd) {
  return listSupportedAiClis().includes(String(cmd || '').trim());
}

// `aih <cli> export|import …` → 同一个原生格式的 backup 路由，带上 provider 作用域。
function buildProviderScopedBackupArgs(cmd, cliName, args) {
  const provider = String(cliName || '').trim();
  const rest = Array.isArray(args) ? args.slice(2).map((item) => String(item || '').trim()).filter(Boolean) : [];
  return [cmd, '__provider__', provider, ...rest];
}

function resolveUniqueCliForAccountId(id, deps = {}) {
  const fs = deps.fs;
  const aiHomeDir = String(deps.aiCliContext && deps.aiCliContext.aiHomeDir || '').trim();
  const listAliases = deps.listCliAccountRefRecords || listCliAccountRefRecords;
  if (!fs || !aiHomeDir || !/^\d+$/.test(String(id || '').trim())) return null;
  const matches = listSupportedAiClis().filter((cliName) => {
    return listAliases(fs, aiHomeDir, cliName, { bestEffort: true })
      .some((record) => record.cliAccountId === String(id));
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

async function runCliRootRouter(rawArgs, deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  // 所有退出都走这里：process.exit() 会丢掉还在队列里的 stdout（管道下是异步的），
  // 实测 `aih shell snippet`（9164 字节）经 execSync 只拿到 8192 字节、断在半行。
  const exit = (code) => exitAfterFlush(processObj, code);
  const { args, cmd } = normalizeRootCommandArgs(rawArgs);

  if (isHelpCommand(cmd)) {
    deps.showHelp();
    exit(0);
    return;
  }

  const handleLsCommand = async () => {
    const lsArg = String(args[1] || '').trim();
    if (lsArg === '--help' || lsArg === '-h' || lsArg === 'help') {
      deps.showLsHelp();
      exit(0);
      return;
    }
    const lsResult = deps.listProfiles();
    if (lsResult && lsResult.interactive) return;
    exit(0);
  };

  const handleSessionsCommand = async () => {
    if (typeof deps.runGlobalPersistentSessionsCommand !== 'function') {
      consoleImpl.error('\x1b[31m[aih] sessions command is unavailable.\x1b[0m');
      exit(1);
      return;
    }
    const result = await Promise.resolve(deps.runGlobalPersistentSessionsCommand(args.slice(1), deps.globalSessionContext || {}));
    if (result && result.entered) return;
    exit(Number.isInteger(result) ? result : 1);
  };

  const preBackupHandlers = {
    '__background': async () => {
      if (String(args[1] || '').trim() !== 'run' || args.length !== 2) {
        consoleImpl.error('[aih] invalid background supervisor invocation.');
        exit(1);
        return;
      }
      if (typeof deps.runBackgroundSupervisor !== 'function') {
        consoleImpl.error('[aih] background supervisor is unavailable.');
        exit(1);
        return;
      }
      await deps.runBackgroundSupervisor(deps.backgroundContext || {});
      exit(0);
    },
    '__ssh_mcp__': async () => {
      const targetIndex = args.indexOf('--target');
      const rootIndex = args.indexOf('--remote-root');
      const target = targetIndex !== -1 ? args[targetIndex + 1] : '';
      const root = rootIndex !== -1 ? args[rootIndex + 1] : '';
      if (typeof deps.runSshMcpServerLoop === 'function') {
        await deps.runSshMcpServerLoop(target, root, processObj);
      } else {
        consoleImpl.error('[aih] runSshMcpServerLoop is unavailable.');
        exit(1);
      }
    },
    proxy: async () => {
      consoleImpl.error('\x1b[31m[aih] `proxy` command has been replaced. Use `aih server ...` or `aih serve`.\x1b[0m');
      exit(1);
    },
    // 远程工作区终端的 SSH 守护（由 Web 终端 PTY 启动，见 lib/server/ssh-remote-supervisor.js）。
    // 参数只有工作区 ID 与 session key；连接配置与凭据每次重连时从 Server 状态库现读。
    '__remote_ws__': async () => {
      const workspaceId = String(args[1] || '').trim();
      const sessionKey = String(args[2] || '').trim();
      if (!/^ws_[a-f0-9]{16}$/.test(workspaceId)) {
        consoleImpl.error('[aih] invalid remote workspace invocation.');
        exit(1);
        return;
      }
      const { runRemoteSupervisor } = require('../../../server/ssh-remote-supervisor');
      const { resolveAiHomeDir } = require('../../../runtime/aih-home');
      const code = await runRemoteSupervisor({
        aiHomeDir: resolveAiHomeDir({ env: processObj.env }),
        workspaceId,
        ...(sessionKey ? { sessionKey } : {})
      });
      exit(code);
    },
    '__usage-probe': async () => {
      const cliName = String(args[1] || '').trim();
      const id = String(args[2] || '').trim();
      if (!cliName || !/^\d+$/.test(id)) {
        processObj.stderr.write('invalid_usage_probe_args');
        exit(1);
        return;
      }
      const buildProbe = typeof deps.buildUsageProbePayloadAsync === 'function'
        ? deps.buildUsageProbePayloadAsync
        : deps.buildUsageProbePayload;
      const payload = await Promise.resolve(buildProbe(cliName, id));
      processObj.stdout.write(`${JSON.stringify(payload)}\n`);
      exit(0);
    },
    usage: async () => {
      if (typeof deps.printModelUsageReport !== 'function') {
        consoleImpl.error('\x1b[31m[aih] model usage accounting is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const usageArgs = args.slice(1);
      if (usageArgs.some((token) => token === '--help' || token === '-h' || token === 'help')) {
        consoleImpl.log('\x1b[36mAIH Model Usage\x1b[0m - Token usage accounting across providers');
        consoleImpl.log('');
        consoleImpl.log('\x1b[90mUsage:\x1b[0m aih usage [stats|models|sessions|session-detail|scan|recalculate-costs] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider codex|claude|gemini|agy|opencode] [--model MODEL] [--session-id ID] [--no-scan] [--json] [--reindex-codex-forks]');
        exit(0);
        return;
      }
      try {
        await Promise.resolve(deps.printModelUsageReport(usageArgs));
        exit(0);
      } catch (error) {
        consoleImpl.error(`\x1b[31m[aih] usage failed: ${error.message}\x1b[0m`);
        consoleImpl.error('\x1b[90mUsage:\x1b[0m aih usage [stats|models|sessions|session-detail|scan|recalculate-costs] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider codex|claude|gemini|agy|opencode] [--model MODEL] [--session-id ID] [--no-scan] [--json] [--reindex-codex-forks]');
        exit(1);
      }
    },
    sessions: handleSessionsCommand,
    ss: handleSessionsCommand,
    ls: handleLsCommand,
    list: handleLsCommand,
    update: async () => {
      const exitCode = await deps.runUpdateCommand(args.slice(1), deps.updateContext);
      exit(Number(exitCode) || 0);
    },
    node: async () => {
      const exitCode = await deps.runNodeCommandRouter(args, deps.nodeContext);
      if (typeof exitCode === 'number') {
        return;
      }
    },
    fabric: async () => {
      const exitCode = await deps.runFabricCommandRouter(args, deps.fabricContext);
      if (typeof exitCode === 'number') {
        return;
      }
    },
    ssh: async () => {
      if (typeof deps.runAihSshCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] ssh command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runAihSshCommand(args, deps.sshContext || {});
      exit(Number.isInteger(code) ? code : 1);
    },
    'clip-agent': async () => {
      if (typeof deps.runClipAgentCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] clip-agent command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runClipAgentCommand(args, deps.clipAgentContext || {});
      exit(Number.isInteger(code) ? code : 1);
    },
    'ssh-clipboard': async () => {
      if (typeof deps.runSshClipboardProbeCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] ssh-clipboard command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runSshClipboardProbeCommand(args, deps.sshClipboardContext || {});
      exit(Number.isInteger(code) ? code : 1);
    },
    provider: async () => {
      const code = await deps.runProviderResourceCommand(args, { ...(deps.providerResourceContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    native: async () => {
      if (String(args[1] || '') !== 'plugin') { consoleImpl.error('[aih] Usage: aih native plugin ...'); exit(1); return; }
      const code = await deps.runNativePluginCommand(args, { ...(deps.nativePluginContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    mcp: async () => {
      const code = await deps.runMcpCommand(args, { ...(deps.mcpContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    skill: async () => {
      const code = await deps.runSkillCommand(args, { ...(deps.skillContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    // 外部 harness（pi / dsh / dsh-tui）：用指定 Provider 的指定账号跑，请求经本地网关 relay。
    harness: async () => {
      const { runHarnessCommand } = require('../harness/router');
      const code = await runHarnessCommand(args.slice(1), {
        fs: deps.fs,
        env: processObj.env,
        cwd: processObj.cwd(),
        stdout: processObj.stdout,
        stderr: processObj.stderr
      });
      exit(Number.isInteger(code) ? code : 1);
    },
    plugin: async () => {
      if (typeof deps.runPluginCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] plugin command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runPluginCommand(args, { ...(deps.pluginContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    // 本机入口转发（nginx / caddy / frp）：status / plan / apply / remove
    edge: async () => {
      if (typeof deps.runEdgeCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] edge command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = deps.runEdgeCommand(args.slice(1), { ...(deps.edgeContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 1);
    },
    // macOS 协议处理器入口：浏览器跳转 zcode:// 时被调用，判定归属（aih 任务 or 转发桌面端）
    'zcode-url': async () => {
      if (typeof deps.runZcodeUrlCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] zcode-url command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runZcodeUrlCommand(args.slice(1), { ...(deps.zcodeUrlContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 0);
    },
    // macOS `zcode:` 协议接管（aih 收自定义协议回调；其它转发给 ZCode Desktop）
    'zcode-scheme': async () => {
      if (typeof deps.runZcodeSchemeCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] zcode-scheme command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = deps.runZcodeSchemeCommand(args.slice(1), { ...(deps.zcodeSchemeContext || {}), consoleImpl });
      exit(Number.isInteger(code) ? code : 0);
    },
    // 账号福利/活动领取（Qoder 每日签到、ZCode 周末套餐）
    claim: async () => {
      if (typeof deps.runClaimCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] claim command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = await deps.runClaimCommand(args.slice(1), {
        ...(deps.claimContext || {}),
        consoleImpl,
        processObj
      });
      exit(Number.isInteger(code) ? code : 1);
    },
    // 终端集成：TAB 补全 / 命令打错时的纠正建议 / rc 片段管理
    shell: async () => {
      if (typeof deps.runShellCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] shell command is unavailable.\x1b[0m');
        exit(1);
        return;
      }
      const code = deps.runShellCommand(args.slice(1), {
        ...(deps.shellContext || {}),
        consoleImpl,
        processObj
      });
      exit(Number.isInteger(code) ? code : 1);
    }
  };

  if (/^\d+$/.test(String(cmd || '').trim())) {
    const resolvedCli = resolveUniqueCliForAccountId(cmd, deps);
    if (resolvedCli) {
      deps.runAiCliCommandRouter(resolvedCli, [resolvedCli, ...args], deps.aiCliContext);
      return;
    }
  }

  if (cmd === 'usage' && /^\d+$/.test(String(args[1] || '').trim())) {
    const targetId = String(args[1]).trim();
    const resolvedCli = resolveUniqueCliForAccountId(targetId, deps);
    if (resolvedCli) {
      deps.runAiCliCommandRouter(resolvedCli, [resolvedCli, 'usage', ...args.slice(1)], deps.aiCliContext);
      return;
    }
  }

  const providerAction = String(args[1] || '').trim();
  if (isSupportedCliName(cmd) && (providerAction === 'export' || providerAction === 'import')) {
    if (await deps.runBackupCommand(providerAction, buildProviderScopedBackupArgs(providerAction, cmd, args), deps.backupContext)) {
      return;
    }
  }

  const preBackupHandler = preBackupHandlers[cmd];
  if (preBackupHandler) {
    await preBackupHandler();
    return;
  }

  if (await deps.runBackupCommand(cmd, args, deps.backupContext)) {
    return;
  }

  const postBackupHandlers = {
    server: async () => {
      try {
        const code = await deps.runServerEntry(args, deps.serverEntryContext);
        if (typeof code === 'number') {
          exit(code);
        }
      } catch (e) {
        consoleImpl.error(`\x1b[31m[aih] server failed: ${e.message}\x1b[0m`);
        exit(1);
      }
    }
  };

  const postBackupHandler = postBackupHandlers[cmd];
  if (postBackupHandler) {
    await postBackupHandler();
    return;
  }

  deps.runAiCliCommandRouter(cmd, args, deps.aiCliContext);
}

module.exports = {
  runCliRootRouter
};
