'use strict';

const path = require('node:path');
const { normalizeRootCommandArgs } = require('./args');
const { listSupportedAiClis } = require('../../services/ai-cli/provider-registry');

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
  return ['export', '__provider__', provider, ...exportArgs];
}

function resolveUniqueCliForAccountId(id, deps = {}) {
  const fs = deps.fs;
  const profilesDir = deps.aiCliContext && deps.aiCliContext.PROFILES_DIR;
  if (!fs || !profilesDir || !/^\d+$/.test(String(id || '').trim())) return null;
  const matches = listSupportedAiClis().filter((cliName) => {
    try {
      return fs.existsSync(path.join(profilesDir, cliName, String(id)));
    } catch (_error) {
      return false;
    }
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

  const handleCountCommand = async () => {
    const summary = deps.countProfiles();
    const providers = summary && summary.providers ? summary.providers : {};
    consoleImpl.log('\x1b[36m[aih]\x1b[0m account counts');
    Object.keys(providers).sort().forEach((provider) => {
      consoleImpl.log(`  - ${provider}: ${providers[provider]}`);
    });
    consoleImpl.log(`  - total: ${Number(summary && summary.total) || 0}`);
    processObj.exit(0);
  };

  const preBackupHandlers = {
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
    ls: handleLsCommand,
    list: handleLsCommand,
    count: handleCountCommand,
    dev: async () => {
      const exitCode = await deps.runDevCommand(args.slice(1), deps.devContext);
      processObj.exit(Number(exitCode) || 0);
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
