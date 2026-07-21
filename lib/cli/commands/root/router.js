'use strict';

const { normalizeRootCommandArgs } = require('./args');
const { listSupportedAiClis } = require('../../services/ai-cli/provider-registry');
const { listCliAccountRefRecords } = require('../../../server/account-ref-store');

function isHelpCommand(cmd) {
  return !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h';
}

function isSupportedCliName(cmd) {
  return listSupportedAiClis().includes(String(cmd || '').trim());
}

function buildProviderScopedExportArgs(cliName, args) {
  const provider = String(cliName || '').trim();
  const exportArgs = Array.isArray(args) ? args.slice(2).map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (exportArgs[0] === 'cliproxyapi') {
    return ['export', 'cliproxyapi', provider];
  }
  if (exportArgs[0] === 'sub2api' || exportArgs[0] === 'antigravity') {
    return ['export', exportArgs[0], provider, ...exportArgs.slice(1)];
  }
  return ['export', '__provider__', provider, ...exportArgs];
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
  const { args, cmd } = normalizeRootCommandArgs(rawArgs);

  if (isHelpCommand(cmd)) {
    deps.showHelp();
    processObj.exit(0);
    return;
  }

  const handleLsCommand = async () => {
    const lsArg = String(args[1] || '').trim();
    if (lsArg === '--help' || lsArg === '-h' || lsArg === 'help') {
      deps.showLsHelp();
      processObj.exit(0);
      return;
    }
    deps.listProfiles();
    processObj.exit(0);
  };

  const handleSessionsCommand = async () => {
    if (typeof deps.runGlobalPersistentSessionsCommand !== 'function') {
      consoleImpl.error('\x1b[31m[aih] sessions command is unavailable.\x1b[0m');
      processObj.exit(1);
      return;
    }
    const result = await Promise.resolve(deps.runGlobalPersistentSessionsCommand(args.slice(1), deps.globalSessionContext || {}));
    if (result && result.entered) return;
    processObj.exit(Number.isInteger(result) ? result : 1);
  };

  const preBackupHandlers = {
    '__background': async () => {
      if (String(args[1] || '').trim() !== 'run' || args.length !== 2) {
        consoleImpl.error('[aih] invalid background supervisor invocation.');
        processObj.exit(1);
        return;
      }
      if (typeof deps.runBackgroundSupervisor !== 'function') {
        consoleImpl.error('[aih] background supervisor is unavailable.');
        processObj.exit(1);
        return;
      }
      await deps.runBackgroundSupervisor(deps.backgroundContext || {});
      processObj.exit(0);
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
        processObj.exit(1);
      }
    },
    proxy: async () => {
      consoleImpl.error('\x1b[31m[aih] `proxy` command has been replaced. Use `aih server ...` or `aih serve`.\x1b[0m');
      processObj.exit(1);
    },
    '__usage-probe': async () => {
      const cliName = String(args[1] || '').trim();
      const id = String(args[2] || '').trim();
      if (!cliName || !/^\d+$/.test(id)) {
        processObj.stderr.write('invalid_usage_probe_args');
        processObj.exit(1);
        return;
      }
      const buildProbe = typeof deps.buildUsageProbePayloadAsync === 'function'
        ? deps.buildUsageProbePayloadAsync
        : deps.buildUsageProbePayload;
      const payload = await Promise.resolve(buildProbe(cliName, id));
      processObj.stdout.write(`${JSON.stringify(payload)}\n`);
      processObj.exit(0);
    },
    usage: async () => {
      if (typeof deps.printModelUsageReport !== 'function') {
        consoleImpl.error('\x1b[31m[aih] model usage accounting is unavailable.\x1b[0m');
        processObj.exit(1);
        return;
      }
      try {
        await Promise.resolve(deps.printModelUsageReport(args.slice(1)));
        processObj.exit(0);
      } catch (error) {
        consoleImpl.error(`\x1b[31m[aih] usage failed: ${error.message}\x1b[0m`);
        consoleImpl.error('\x1b[90mUsage:\x1b[0m aih usage [stats|models|sessions|session-detail|scan|recalculate-costs] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider codex|claude|gemini|agy|opencode] [--model MODEL] [--session-id ID] [--no-scan] [--json] [--reindex-codex-forks]');
        processObj.exit(1);
      }
    },
    sessions: handleSessionsCommand,
    ss: handleSessionsCommand,
    ls: handleLsCommand,
    list: handleLsCommand,
    update: async () => {
      const exitCode = await deps.runUpdateCommand(args.slice(1), deps.updateContext);
      processObj.exit(Number(exitCode) || 0);
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
        processObj.exit(1);
        return;
      }
      const code = await deps.runAihSshCommand(args, deps.sshContext || {});
      processObj.exit(Number.isInteger(code) ? code : 1);
    },
    'clip-agent': async () => {
      if (typeof deps.runClipAgentCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] clip-agent command is unavailable.\x1b[0m');
        processObj.exit(1);
        return;
      }
      const code = await deps.runClipAgentCommand(args, deps.clipAgentContext || {});
      processObj.exit(Number.isInteger(code) ? code : 1);
    },
    'ssh-clipboard': async () => {
      if (typeof deps.runSshClipboardProbeCommand !== 'function') {
        consoleImpl.error('\x1b[31m[aih] ssh-clipboard command is unavailable.\x1b[0m');
        processObj.exit(1);
        return;
      }
      const code = await deps.runSshClipboardProbeCommand(args, deps.sshClipboardContext || {});
      processObj.exit(Number.isInteger(code) ? code : 1);
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

  if (isSupportedCliName(cmd) && String(args[1] || '').trim() === 'export') {
    if (await deps.runBackupCommand('export', buildProviderScopedExportArgs(cmd, args), deps.backupContext)) {
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
          processObj.exit(code);
        }
      } catch (e) {
        consoleImpl.error(`\x1b[31m[aih] server failed: ${e.message}\x1b[0m`);
        processObj.exit(1);
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
