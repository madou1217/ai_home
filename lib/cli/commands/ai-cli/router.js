'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const {
  hasAccountCredentials,
  readAccountCredentials,
  writeAccountCredentials
} = require('../../../server/account-credential-store');
const {
  resolveCliAccountRef,
  resolveAccountRefByCliId
} = require('../../../server/account-ref-store');
const { registerAccountIdentity } = require('../../../account/account-registration');
const { buildApiKeyIdentity } = require('../../../account/transfer-core');
const { normalizeIdentitySeed } = require('../../../account/account-identity');
const { AI_CLI_CONFIGS, listSupportedAiClis } = require('../../services/ai-cli/provider-registry');
const {
  AIH_SERVER_PROFILE_ID,
  buildAihServerProfileEnv,
  supportsAihServerProfile
} = require('../../../account/self-relay-account');
const { createCodexDesktopHookService } = require('../../../server/codex-desktop-hook');
const { validateCodexDesktopAccount } = require('../../../server/codex-desktop-account');
const {
  clearDefaultAccountRef,
  readDefaultAccountRef,
  writeDefaultAccountRef
} = require('../../../account/default-account-store');
const persistentSession = require('../../../runtime/persistent-session');
const { resolveCliPath: defaultResolveCliPath } = require('../../../runtime/platform-runtime');
const {
  buildProviderHomeDiagnostics,
  formatProviderHomeDiagnostics
} = require('../../services/ai-cli/home-diagnostics');
const {
  canUseSessionPicker,
  shouldUseSyncSessionPicker,
  selectPersistentSessionRow,
  selectPersistentSessionRowAsync,
  listPersistentSessions,
  closePersistentSession,
  listProviderAccountScopes,
  enterGlobalPersistentSession
} = require('../../services/ai-cli/persistent-session-list');
const {
  prepareCurrentTerminalProviderIcon,
  runTerminalIconCommand
} = require('../../services/terminal-icons');

// Pull the aih-level persistent-session flags out of argv and stash them in env
// for the runtime, returning argv with them removed so the rest passes through to
// the provider CLI. Flags are deliberately namespaced to avoid colliding with the
// providers' own flags:
//   -S <name> / --session <name> / --session=<name>  → WHICH session (label)
//   -R / --aih-resume                                → resume/take over THIS
//        project's session even if it's live elsewhere (e.g. an SSH client still
//        attached on another machine; the other client is detached). NOT
//        `--resume`, which is claude's.
//   -M / --aih-mirror                                → attach to THIS project's
//        session SHARED — both windows mirror the same session in real time,
//        neither is kicked (cross-machine screen sharing).
function extractSessionLabelFlag(args, env) {
  const input = Array.isArray(args) ? args.slice() : [];
  const out = [];
  let label = '';
  let resume = false;
  let mirror = false;
  let remote = '';
  for (let i = 0; i < input.length; i += 1) {
    const token = String(input[i] == null ? '' : input[i]);
    if (token === '-S' || token === '--session') {
      const next = input[i + 1];
      if (next != null) { label = String(next); i += 1; }
      continue;
    }
    const m = token.match(/^(?:--session|-S)=(.*)$/);
    if (m) { label = m[1]; continue; }
    if (token === '-R' || token === '--aih-resume') { resume = true; continue; }
    if (token === '-M' || token === '--aih-mirror') { mirror = true; continue; }
    if (token === '--remote' || token === '--aih-remote') {
      const next = input[i + 1];
      if (next != null) { remote = String(next); i += 1; }
      continue;
    }
    const rm = token.match(/^(?:--remote|--aih-remote)=(.*)$/);
    if (rm) { remote = rm[1]; continue; }
    out.push(input[i]);
  }
  if (label && env) env[persistentSession.SESSION_ENV] = label;
  if (resume && env) env[persistentSession.RESUME_ENV] = '1';
  if (mirror && env) env[persistentSession.MIRROR_ENV] = '1';
  if (remote && env) env.AIH_REMOTE_SSH = remote;
  return out;
}

function registerApiKeyAccount(fs, aiHomeDir, cliName, cliAccountId, data) {
  const provider = String(cliName || '').trim();
  const id = String(cliAccountId || '').trim();
  const homeDir = String(aiHomeDir || '').trim();
  if (!provider || !/^\d+$/.test(id) || !homeDir || !data || typeof data !== 'object') return '';
  const identitySeed = normalizeIdentitySeed(buildApiKeyIdentity(provider, { config: data }));
  if (!identitySeed) return '';
  const accountRef = registerAccountIdentity(fs, homeDir, {
    provider,
    cliAccountId: id,
    identitySeed
  }).accountRef;
  writeAccountCredentials(fs, homeDir, accountRef, data);
  return accountRef;
}

function runAiCliCommandRouter(cmd, args, context = {}) {
  const processImpl = context.processImpl || process;
  const fs = context.fs;
  const aiHomeDir = context.aiHomeDir;
  const HOST_HOME_DIR = context.HOST_HOME_DIR;
  const askYesNo = context.askYesNo;
  const showCliUsage = context.showCliUsage;
  const showLsHelp = context.showLsHelp;
  const listProfiles = context.listProfiles;
  const showCodexPolicy = context.showCodexPolicy;
  const setCodexPolicy = context.setCodexPolicy;
  const getProfileDir = context.getProfileDir;
  const renderStageProgress = context.renderStageProgress;
  const printAllUsageSnapshots = context.printAllUsageSnapshots;
  const printUsageSnapshot = context.printUsageSnapshot;
  const printUsageSnapshotAsync = context.printUsageSnapshotAsync;
  const runUnifiedImport = context.runUnifiedImport;
  const parseCodexBulkImportArgs = context.parseCodexBulkImportArgs;
  const importCodexTokensFromOutput = context.importCodexTokensFromOutput;
  const extractActiveEnv = context.extractActiveEnv;
  const findEnvSandbox = context.findEnvSandbox;
  const getNextId = context.getNextId;
  const createAccount = context.createAccount;
  const runCliPty = context.runCliPty;
  const checkStatus = context.checkStatus;
  const getAccountQuotaState = context.getAccountQuotaState;
  const ensureSessionStoreLinks = context.ensureSessionStoreLinks;
  const syncGlobalConfigToHost = context.syncGlobalConfigToHost;
  const restartDetectedDesktopClient = context.restartDetectedDesktopClient;
  const parseDeleteSelectorTokens = context.parseDeleteSelectorTokens;
  const deleteAccountsForCli = context.deleteAccountsForCli;
  const deleteAllAccountsForCli = context.deleteAllAccountsForCli;
  const readServerConfig = context.readServerConfig;
  const resolveCliPath = context.resolveCliPath || defaultResolveCliPath;
  const startCliPty = (targetCliName, targetId, targetForwardArgs = [], isLoginFlow = false) => {
    const safeForwardArgs = Array.isArray(targetForwardArgs) ? targetForwardArgs : [];
    if (!isLoginFlow) {
      prepareCurrentTerminalProviderIcon(targetCliName, {
        processImpl,
        fs,
        spawnSync: context.spawnSync,
        repoRoot: context.repoRoot,
        aihCommand: context.aihCommand,
        qdbusCommand: context.qdbusCommand
      });
    }
    const scope = /^\d+$/.test(String(targetId || '').trim())
      ? resolveCliAccount(targetCliName, targetId)
      : null;
    const gateway = String(targetId || '').trim() === AIH_SERVER_PROFILE_ID;
    runCliPty(
      targetCliName,
      scope ? scope.accountRef : '',
      safeForwardArgs,
      isLoginFlow,
      {
        cliAccountId: /^\d+$/.test(String(targetId || '').trim()) ? String(targetId).trim() : '',
        loginSessionId: isLoginFlow ? `auth-${crypto.randomUUID()}` : '',
        gateway
      }
    );
  };

  const cliName = cmd;
  if (!AI_CLI_CONFIGS[cliName]) {
    console.error(`\x1b[31m[aih] Unknown tool '${cliName}'. Supported: ${listSupportedAiClis().join(', ')}\x1b[0m`);
    processImpl.exit(1);
    return;
  }

  // Consume the aih-level persistent-session label (`-S <name>` / `--session
  // <name>`) before anything else so it never leaks to the provider CLI. The
  // label selects WHICH tmux session to attach/create for this account, enabling
  // multiple concurrent named windows in the same project. We deliberately use a
  // namespaced flag (not bare `-s`, which collides with e.g. codex `--sandbox`).
  args = extractSessionLabelFlag(args, processImpl.env);

  let idOrAction = args[1];
  let forwardArgs = [];
  const USAGE_ACTIONS = new Set(['usage', '--usage', 'stats']);
  const POLICY_ACTIONS = new Set(['policy']);
  const HOME_ACTIONS = new Set(['home']);
  const DELETE_ACTIONS = new Set(['delete']);
  const DELETE_ALL_ACTIONS = new Set(['deleteall', 'delete-all']);
  const REMOVED_ACTIONS = new Set(['auto', 'count', 'cleanup', 'up', 'down']);
  const KNOWN_ACTIONS = new Set(['ls', 'sessions', 'terminal-icon', 'terminal-icons', 'set-default', 'unset-default', 'set-mobile', 'unset-mobile', 'login', ...POLICY_ACTIONS, ...HOME_ACTIONS, ...USAGE_ACTIONS, ...DELETE_ACTIONS, ...DELETE_ALL_ACTIONS]);
  const NO_BROWSER_FLAG = '--no-browser';
  const hasNoBrowserFlag = (values) => Array.isArray(values) && values.some((item) => String(item || '').trim() === NO_BROWSER_FLAG);
  const stripNoBrowserFlag = (values) => (Array.isArray(values) ? values.filter((item) => String(item || '').trim() !== NO_BROWSER_FLAG) : []);
  // 原生参数完整穿透：除 aih 自身保留动作（KNOWN_ACTIONS）与已废弃动作
  // （REMOVED_ACTIONS）外，任何非账号编号的首 token 都视为原生子命令/参数，
  // 整段转发给原生客户端（例如 resume / exec / mcp / goal / plan / --flag / 直接 prompt）。
  const isNativePassThroughAction = (value) => {
    const token = String(value || '').trim();
    if (!token || KNOWN_ACTIONS.has(token) || REMOVED_ACTIONS.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    return true;
  };
  const parseUsageJobsArgs = (tokens) => {
    const items = Array.isArray(tokens) ? tokens : [];
    let jobs = null;
    let preflight = false;
    let refresh = false;
    for (let i = 0; i < items.length; i += 1) {
      const t = String(items[i] || '').trim();
      if (!t) continue;
      if (t === '--preflight') {
        preflight = true;
        continue;
      }
      if (t === '--refresh' || t === '--no-cache') {
        refresh = true;
        continue;
      }
      if (t === '-j') {
        const next = String(items[i + 1] || '').trim();
        if (!/^\d+$/.test(next)) return { ok: false, error: 'Invalid jobs value. Usage: -j <number>' };
        jobs = Number(next);
        i += 1;
        continue;
      }
      if (/^-j\d+$/.test(t)) {
        jobs = Number(t.slice(2));
        continue;
      }
      return { ok: false, error: `Unknown usage scan arg: ${t}` };
    }
    if (jobs !== null && (!Number.isFinite(jobs) || jobs <= 0)) {
      return { ok: false, error: 'Jobs must be a positive integer.' };
    }
    return { ok: true, jobs, preflight, refresh };
  };
  const parseUsageQueryArgs = (tokens) => {
    const items = Array.isArray(tokens) ? tokens : [];
    let noCache = false;
    let preflight = false;
    for (let i = 0; i < items.length; i += 1) {
      const t = String(items[i] || '').trim();
      if (!t) continue;
      if (t === '--no-cache' || t === '--refresh') {
        noCache = true;
        continue;
      }
      if (t === '--preflight') {
        preflight = true;
        continue;
      }
      return { ok: false, error: `Unknown usage query arg: ${t}` };
    }
    return { ok: true, noCache, preflight };
  };
  const parseSetDefaultArgs = (tokens) => {
    const items = Array.isArray(tokens) ? tokens : [];
    let restartClient = false;
    let forceQuitClient = false;
    for (let i = 0; i < items.length; i += 1) {
      const token = String(items[i] || '').trim();
      if (!token) continue;
      if (token === '--restart-client') {
        restartClient = true;
        continue;
      }
      if (token === '--force-quit-client') {
        restartClient = true;
        forceQuitClient = true;
        continue;
      }
      return {
        ok: false,
        error: `Unknown set-default arg: ${token}`
      };
    }
    return { ok: true, restartClient, forceQuitClient };
  };
  const accountStorageDir = String(aiHomeDir || '').trim();
  const resolveCliAccount = (provider, cliAccountId) => resolveAccountRefByCliId(
    fs,
    accountStorageDir,
    provider,
    cliAccountId,
    { bestEffort: true }
  );
  const cliAccountExists = (provider, cliAccountId) => {
    const account = resolveCliAccount(provider, cliAccountId);
    return Boolean(account && hasAccountCredentials(fs, accountStorageDir, account.accountRef));
  };
  const readDefaultCliAccountId = (provider) => {
    const accountRef = readDefaultAccountRef(fs, accountStorageDir, provider);
    if (!accountRef) return '';
    const account = resolveCliAccountRef(fs, accountStorageDir, accountRef, { bestEffort: true });
    return String(account && account.cliAccountId || '').trim();
  };
  const writeDefaultCliAccountId = (provider, cliAccountId) => {
    const account = resolveCliAccount(provider, cliAccountId);
    if (!account) throw new Error('invalid_default_account');
    return writeDefaultAccountRef(fs, accountStorageDir, provider, account.accountRef);
  };
  const resolveProfileDir = (provider, cliSelector) => {
    if (typeof getProfileDir !== 'function') return '';
    if (String(cliSelector || '').trim() === AIH_SERVER_PROFILE_ID) {
      return getProfileDir(provider, '', { gateway: true });
    }
    const account = resolveCliAccount(provider, cliSelector);
    return account ? getProfileDir(provider, account.accountRef) : '';
  };
  const useBuiltinServerProfile = supportsAihServerProfile(cliName) && !idOrAction;
  if (idOrAction === 'help') {
    showCliUsage(cliName);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'ls') {
    const lsArg = String(args[2] || '').trim();
    if (lsArg === '--help' || lsArg === '-h' || lsArg === 'help') {
      showLsHelp(cliName);
      processImpl.exit(0);
      return;
    }
    if (lsArg && !/^\d+$/.test(lsArg)) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih ${cliName} ls [id]\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    listProfiles(cliName, lsArg || null);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'terminal-icon' || idOrAction === 'terminal-icons') {
    const exitCode = runTerminalIconCommand(cliName, args.slice(2), {
      fs,
      path,
      processImpl,
      consoleImpl: console
    });
    processImpl.exit(exitCode);
    return;
  }

  const isValidProviderProfileId = (value) => {
    const normalized = String(value || '').trim();
    return /^\d+$/.test(normalized)
      || (supportsAihServerProfile(cliName) && normalized === AIH_SERVER_PROFILE_ID);
  };
  const isValidHomeTargetId = (value) => {
    return isValidProviderProfileId(value);
  };
  const resolveHomeDiagnosticTargetId = (explicitId = '') => {
    const normalized = String(explicitId || '').trim();
    if (normalized) return normalized;
    if (supportsAihServerProfile(cliName)) return AIH_SERVER_PROFILE_ID;
    const defaultId = readDefaultCliAccountId(cliName);
    if (defaultId) return defaultId;
    return '1';
  };
  const printHomeDiagnostics = (targetId) => {
    const profileDir = resolveProfileDir(cliName, targetId);
    let accountEnv = {};
    if (targetId === AIH_SERVER_PROFILE_ID) {
      let serverConfig = {};
      try {
        serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
      } catch (_error) {}
      accountEnv = buildAihServerProfileEnv(cliName, serverConfig) || {};
    } else {
      const account = resolveCliAccount(cliName, targetId);
      accountEnv = account
        ? readAccountCredentials(fs, accountStorageDir, account.accountRef)
        : {};
    }
    const diagnostic = buildProviderHomeDiagnostics(cliName, profileDir, processImpl.env || {}, {
      fs,
      path,
      cliAccountId: targetId,
      hostHomeDir: HOST_HOME_DIR,
      aiHomeDir: accountStorageDir,
      accountEnv
    });
    console.log(formatProviderHomeDiagnostics(diagnostic));
  };

  if (idOrAction && HOME_ACTIONS.has(idOrAction)) {
    const explicitId = String(args[2] || '').trim();
    if (explicitId && !isValidHomeTargetId(explicitId)) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih ${cliName} home [id]\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    printHomeDiagnostics(resolveHomeDiagnosticTargetId(explicitId));
    processImpl.exit(0);
    return;
  }

  if (idOrAction && /^\d+$/.test(idOrAction) && HOME_ACTIONS.has(String(args[2] || '').trim())) {
    const extraArg = String(args[3] || '').trim();
    if (extraArg) {
      console.error(`\x1b[31m[aih] Invalid arg. Usage: aih ${cliName} <id> home\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    printHomeDiagnostics(idOrAction);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'sessions') {
    const sessId = String(args[2] || '').trim();
    if (sessId && !isValidProviderProfileId(sessId)) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih ${cliName} sessions [id]\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const availableSessionScopes = listProviderAccountScopes(cliName, {
      fs,
      aiHomeDir: accountStorageDir
    });
    const accountScopes = sessId
      ? availableSessionScopes.filter((scope) => scope.cliAccountId === sessId)
      : availableSessionScopes;
    if (!accountScopes.length) {
      console.log(`\x1b[36m[aih]\x1b[0m No ${cliName} accounts found.`);
    }
    const interactivePicker = canUseSessionPicker(processImpl, fs, context.readSessionPickerKey);
    const collectRows = (collectOnly) => {
      const collectedRows = [];
      let printedAny = false;
      for (const accountScope of accountScopes) {
        const result = listPersistentSessions(cliName, accountScope.accountRef, {
          processImpl,
          fs,
          spawnSync: context.spawnSync,
          resolveCliPath,
          askYesNo,
          aiHomeDir: accountStorageDir,
          cliAccountId: accountScope.cliAccountId,
          gateway: accountScope.gateway === true,
          hostHomeDir: HOST_HOME_DIR,
          agentSessionTitleResolver: context.agentSessionTitleResolver,
          readCodexThreadRecords: context.readCodexThreadRecords,
          DatabaseSync: context.DatabaseSync,
          collectOnly,
          silentEmpty: collectOnly || !sessId,
          silentUnavailable: collectOnly
        });
        const rows = result && Array.isArray(result.rows) ? result.rows : [];
        if (rows.length > 0) {
          printedAny = true;
          collectedRows.push(...rows);
        }
        if (!collectOnly && sessId && result && result.rows && result.rows.length === 0) {
          printedAny = true;
        }
      }
      return { rows: collectedRows, printedAny };
    };
    const collected = collectRows(interactivePicker);
    if (interactivePicker && collected.rows.length > 0) {
      const handleSelected = (selected) => {
        if (selected) {
          const entered = enterGlobalPersistentSession(selected, {
            processImpl,
            consoleImpl: console,
            runCliPty: (targetCliName, targetAccountRef, forwardArgs, isLoginFlow, runtimeOptions) => {
              prepareCurrentTerminalProviderIcon(targetCliName, {
                processImpl,
                fs,
                spawnSync: context.spawnSync,
                repoRoot: context.repoRoot,
                aihCommand: context.aihCommand,
                qdbusCommand: context.qdbusCommand
              });
              runCliPty(targetCliName, targetAccountRef, forwardArgs, isLoginFlow, runtimeOptions);
            }
          });
          if (!entered) {
            console.error('\x1b[31m[aih] Cannot enter selected session: PTY runtime is unavailable.\x1b[0m');
            processImpl.exit(1);
          }
          return;
        }
        processImpl.exit(0);
      };
      const pickerOptions = {
        processImpl,
        fs,
        readKey: context.readSessionPickerKey,
        refreshRows: () => collectRows(true).rows,
        closeSession: (row) => closePersistentSession(row, {
          processImpl,
          fs,
          spawnSync: context.spawnSync,
          resolveCliPath,
          closePersistentSession: context.closePersistentSession
        }),
        refreshIntervalMs: context.sessionPickerRefreshIntervalMs
      };
      const useSyncPicker = shouldUseSyncSessionPicker(context, processImpl);
      if (useSyncPicker) {
        handleSelected(selectPersistentSessionRow(collected.rows, pickerOptions));
      } else {
        return selectPersistentSessionRowAsync(collected.rows, pickerOptions).then(handleSelected);
      }
      return;
    } else if (!collected.printedAny && !sessId && accountScopes.length > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m ${cliName}：当前没有活跃的持久会话。`);
    }
    processImpl.exit(0);
    return;
  }

  if (idOrAction && DELETE_ACTIONS.has(idOrAction)) {
    let targetIds = [];
    try {
      targetIds = typeof parseDeleteSelectorTokens === 'function'
        ? parseDeleteSelectorTokens(args.slice(2))
        : [];
    } catch (error) {
      console.error(`\x1b[31m[aih] Invalid delete selector. Use IDs like 1,2,3 or ranges like 1-9.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (targetIds.length === 0) {
      console.error(`\x1b[31m[aih] No valid account IDs provided. Usage: aih ${cliName} delete <id[,id...|start-end]...>\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const result = typeof deleteAccountsForCli === 'function'
      ? deleteAccountsForCli(cliName, targetIds)
      : { deletedIds: [], missingIds: targetIds.slice() };
    console.log(`\x1b[36m[aih]\x1b[0m deleted ${result.deletedIds.length} ${cliName} account(s).`);
    if (result.deletedIds.length > 0) {
      console.log(`  - ${result.deletedIds.join(', ')}`);
    }
    if (Array.isArray(result.missingIds) && result.missingIds.length > 0) {
      console.log(`\x1b[90m[aih]\x1b[0m missing: ${result.missingIds.join(', ')}`);
    }
    processImpl.exit(0);
    return;
  }

  if (idOrAction && DELETE_ALL_ACTIONS.has(idOrAction)) {
    const result = typeof deleteAllAccountsForCli === 'function'
      ? deleteAllAccountsForCli(cliName)
      : { deletedIds: [], totalBeforeDelete: 0 };
    console.log(`\x1b[36m[aih]\x1b[0m deleted ${result.deletedIds.length}/${Number(result.totalBeforeDelete) || 0} ${cliName} account(s).`);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === '--help' || idOrAction === '-h') {
    showCliUsage(cliName);
    processImpl.exit(0);
    return;
  }

  if (idOrAction && POLICY_ACTIONS.has(idOrAction)) {
    if (cliName !== 'codex') {
      console.error(`\x1b[31m[aih] ${cliName} policy is unsupported. Only codex policy is available.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const policyAction = String(args[2] || '').trim().toLowerCase();
    if (!policyAction || policyAction === 'show') {
      showCodexPolicy();
      processImpl.exit(0);
      return;
    }
    if (policyAction === 'set') {
      try {
        setCodexPolicy(args[3]);
        processImpl.exit(0);
      } catch (e) {
        console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
        console.log('\x1b[90mUsage:\x1b[0m aih codex policy [set <workspace-write|read-only|danger-full-access>]');
        processImpl.exit(1);
      }
      return;
    }
    console.error(`\x1b[31m[aih] Unknown policy action '${policyAction}'.\x1b[0m`);
    console.log('\x1b[90mUsage:\x1b[0m aih codex policy [set <workspace-write|read-only|danger-full-access>]');
    processImpl.exit(1);
    return;
  }

  if (idOrAction && USAGE_ACTIONS.has(idOrAction)) {
    const targetId = args[2];
    const scanArgv = args.slice(2);
    if (!targetId || String(targetId).startsWith('-')) {
      const parsed = parseUsageJobsArgs(scanArgv);
      if (!parsed.ok) {
        console.error(`\x1b[31m[aih] ${parsed.error}\x1b[0m`);
        processImpl.exit(1);
        return;
      }
      Promise.resolve(printAllUsageSnapshots(cliName, { jobs: parsed.jobs, preflight: parsed.preflight, refresh: parsed.refresh }))
        .then(() => processImpl.exit(0))
        .catch((e) => {
          console.error(`\x1b[31m[aih] usage scan failed: ${e.message}\x1b[0m`);
          processImpl.exit(1);
        });
      return;
    }
    if (!/^\d+$/.test(targetId)) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih ${cliName} usage <id>\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const parsedQuery = parseUsageQueryArgs(args.slice(3));
    if (!parsedQuery.ok) {
      console.error(`\x1b[31m[aih] ${parsedQuery.error}\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (!cliAccountExists(cliName, targetId)) {
      console.error(`\x1b[31m[aih] Account ID ${targetId} does not exist.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const runPrintUsage = typeof printUsageSnapshotAsync === 'function'
      ? printUsageSnapshotAsync
      : printUsageSnapshot;
    Promise.resolve(runPrintUsage(cliName, targetId, { noCache: parsedQuery.noCache, preflight: parsedQuery.preflight }))
      .then(() => processImpl.exit(0))
      .catch((e) => {
        console.error(`\x1b[31m[aih] usage query failed: ${e.message}\x1b[0m`);
        processImpl.exit(1);
      });
    return;
  }

  if (idOrAction === 'import' && typeof runUnifiedImport === 'function') {
    Promise.resolve(runUnifiedImport(args.slice(2), {
      provider: cliName,
      log: console.log,
      error: console.error,
      renderStageProgress
    }))
      .then((result) => {
        if (result.failedSources.length > 0) {
          processImpl.exit(1);
          return;
        }
        processImpl.exit(0);
      })
      .catch((e) => {
        console.error(`\x1b[31m[aih] ${cliName} import failed: ${e.message}\x1b[0m`);
        processImpl.exit(1);
      });
    return;
  }

  if (idOrAction === 'set-default') {
    const targetId = args[2];
    const setDefaultArgs = parseSetDefaultArgs(args.slice(3));
    if (!targetId || !/^\d+$/.test(targetId)) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih ${cliName} set-default <id> [--restart-client] [--force-quit-client]\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (!setDefaultArgs.ok) {
      console.error(`\x1b[31m[aih] ${setDefaultArgs.error}. Usage: aih ${cliName} set-default <id> [--restart-client] [--force-quit-client]\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (!cliAccountExists(cliName, targetId)) {
      console.error(`\x1b[31m[aih] Account ID ${targetId} does not exist.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const targetAccount = resolveCliAccount(cliName, targetId);
    if (typeof ensureSessionStoreLinks === 'function') {
      ensureSessionStoreLinks(cliName, targetAccount.accountRef);
    }
    if (typeof syncGlobalConfigToHost === 'function') {
      const syncResult = syncGlobalConfigToHost(cliName, targetAccount.accountRef);
      if (!syncResult || !syncResult.ok) {
        const reason = syncResult && syncResult.reason ? syncResult.reason : 'unknown_error';
        console.error(`\x1b[31m[aih] Failed to sync ${cliName} account ${targetId} to host global config (${reason}).\x1b[0m`);
        processImpl.exit(1);
        return;
      }
    }
    writeDefaultCliAccountId(cliName, targetId);
    console.log(`\x1b[32m[Success]\x1b[0m Set Account ID ${targetId} as default for ${cliName} in ai-home and synced host config.`);
    if (setDefaultArgs.restartClient && typeof restartDetectedDesktopClient === 'function') {
      try {
        const restartResult = restartDetectedDesktopClient(cliName, {
          forceQuit: setDefaultArgs.forceQuitClient
        });
        if (restartResult && restartResult.detected && restartResult.restarted) {
          if (restartResult.forceQuit) {
            console.log(`\x1b[36m[aih]\x1b[0m Force-quit and restarted local ${restartResult.clientName || cliName} desktop client to reload host auth.`);
          } else {
            console.log(`\x1b[36m[aih]\x1b[0m Restarted local ${restartResult.clientName || cliName} desktop client to reload host auth.`);
          }
        } else if (restartResult && restartResult.launched) {
          console.log(`\x1b[36m[aih]\x1b[0m ${restartResult.clientName || cliName} desktop client was not running; launched local ${restartResult.clientName || cliName} desktop client using learned path.`);
        } else if (restartResult && restartResult.reason === 'no_saved_path') {
          console.log(`\x1b[33m[aih]\x1b[0m Open ${restartResult.clientName || cliName} desktop app once manually first, then rerun with --restart-client so ai-home can learn and reuse its path.`);
        } else if (restartResult && restartResult.reason === 'saved_path_missing') {
          console.log(`\x1b[33m[aih]\x1b[0m Learned ${restartResult.clientName || cliName} desktop path is no longer valid. Open the app once manually, then rerun with --restart-client to refresh the saved path.`);
        } else if (restartResult && restartResult.detected) {
          const reason = restartResult.reason ? ` (${restartResult.reason})` : '';
          console.log(`\x1b[33m[aih]\x1b[0m Detected local ${restartResult.clientName || cliName} desktop client but restart was skipped${reason}.`);
        } else if (restartResult && restartResult.reason && restartResult.reason !== 'not_running') {
          const reason = restartResult.reason ? ` (${restartResult.reason})` : '';
          console.log(`\x1b[33m[aih]\x1b[0m Desktop client restart skipped${reason}.`);
        }
      } catch (error) {
        console.log(`\x1b[33m[aih]\x1b[0m Desktop client restart skipped (${error.message}).`);
      }
    }
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'unset-default') {
    const extraArg = String(args[2] || '').trim();
    if (extraArg) {
      console.error(`\x1b[31m[aih] Invalid arg. Usage: aih ${cliName} unset-default\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    try {
      clearDefaultAccountRef(fs, accountStorageDir, cliName);
    } catch (error) {
      console.error(`\x1b[31m[aih] Failed to unset default account (${error.message}).\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    console.log(`\x1b[32m[Success]\x1b[0m Cleared default account for ${cliName}.`);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'set-mobile') {
    const targetId = args[2];
    const extraArg = String(args[3] || '').trim();
    if (cliName !== 'codex') {
      console.error(`\x1b[31m[aih] set-mobile is only supported for codex. Usage: aih codex set-mobile <id>\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (!targetId || !/^\d+$/.test(targetId) || extraArg) {
      console.error(`\x1b[31m[aih] Invalid ID. Usage: aih codex set-mobile <id>\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const targetAccount = resolveCliAccount('codex', targetId);
    if (!targetAccount) {
      console.error(`\x1b[31m[aih] Account ID ${targetId} does not exist.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const validation = validateCodexDesktopAccount(fs, {
      accountRef: targetAccount.accountRef,
      aiHomeDir: accountStorageDir,
      processObj: processImpl
    });
    if (!validation.ok) {
      console.error(`\x1b[31m[aih] Codex App account requires a usable ChatGPT OAuth account.\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const service = createCodexDesktopHookService({
      fs,
      path,
      processObj: processImpl,
      aiHomeDir: accountStorageDir,
      hostHomeDir: HOST_HOME_DIR
    });
    const result = service.setDesktopAccountRef(targetAccount.accountRef);
    if (!result || !result.ok) {
      const reason = result && result.reason ? result.reason : 'unknown_error';
      console.error(`\x1b[31m[aih] Failed to set Codex Mobile account (${reason}).\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    console.log(`\x1b[32m[Success]\x1b[0m Set Codex Account ID ${targetId} as Codex App account.`);
    processImpl.exit(0);
    return;
  }

  if (idOrAction === 'unset-mobile') {
    const extraArg = String(args[2] || '').trim();
    if (cliName !== 'codex') {
      console.error(`\x1b[31m[aih] unset-mobile is only supported for codex. Usage: aih codex unset-mobile\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    if (extraArg) {
      console.error(`\x1b[31m[aih] Invalid arg. Usage: aih codex unset-mobile\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    const service = createCodexDesktopHookService({
      fs,
      path,
      processObj: processImpl,
      aiHomeDir: accountStorageDir,
      hostHomeDir: HOST_HOME_DIR
    });
    const currentMobileRef = service.getDesktopAccountRef();
    const result = currentMobileRef
      ? service.clearDesktopAccountRef(currentMobileRef)
      : { ok: true, stateFilePath: '', desktopAccountRef: '', changed: false };
    if (!result || !result.ok) {
      const reason = result && result.reason ? result.reason : 'unknown_error';
      console.error(`\x1b[31m[aih] Failed to unset Codex Mobile account (${reason}).\x1b[0m`);
      processImpl.exit(1);
      return;
    }
    console.log(`\x1b[32m[Success]\x1b[0m Cleared Codex App account.`);
    processImpl.exit(0);
    return;
  }

  if (useBuiltinServerProfile) {
    forwardArgs = args.slice(1);
    startCliPty(cliName, AIH_SERVER_PROFILE_ID, forwardArgs, false, forwardArgs);
    return;
  }

  if (supportsAihServerProfile(cliName) && idOrAction === AIH_SERVER_PROFILE_ID) {
    forwardArgs = args.slice(2);
    startCliPty(cliName, AIH_SERVER_PROFILE_ID, forwardArgs, false, [AIH_SERVER_PROFILE_ID, ...forwardArgs]);
    return;
  }

  if (supportsAihServerProfile(cliName) && isNativePassThroughAction(idOrAction)) {
    startCliPty(cliName, AIH_SERVER_PROFILE_ID, args.slice(1), false, args.slice(1));
    return;
  }

  // 仅废弃动作仍报错；其它非账号编号的首 token 一律视为原生参数，
  // 落到默认账号（含 gemini/agy 这类无内置 server profile 的 provider）整段穿透。
  if (idOrAction && REMOVED_ACTIONS.has(idOrAction)) {
    console.error(`\x1b[31m[aih]\x1b[0m Unknown subcommand: ${idOrAction}`);
    showCliUsage(cliName);
    processImpl.exit(1);
    return;
  }

  const activeEnv = extractActiveEnv(cliName);
  if (activeEnv && !idOrAction) {
    let matchedId = findEnvSandbox(cliName, activeEnv);
    if (!matchedId) {
      matchedId = getNextId(cliName);
      createAccount(cliName, matchedId, true);
      const accountRef = registerApiKeyAccount(fs, accountStorageDir, cliName, matchedId, activeEnv);
      if (!accountRef) throw new Error('account_ref_registration_failed');

      console.log(`\x1b[36m[aih]\x1b[0m Auto-detected API Keys! Created Sandbox \x1b[32m${matchedId}\x1b[0m bound to these keys.`);
    } else {
      console.log(`\x1b[36m[aih]\x1b[0m Auto-detected API Keys! Routing to existing Sandbox \x1b[32m${matchedId}\x1b[0m.`);
    }
    startCliPty(cliName, matchedId, args.slice(1), false, args.slice(1));
    return;
  }

  if (idOrAction === 'login') {
    const mode = args[2];
    const loginForwardArgs = args.slice(2);
    const nextId = getNextId(cliName);
    if (mode === 'api_key') {
      console.log(`\n\x1b[36m[aih]\x1b[0m Configuring API Key mode for Sandbox \x1b[32m${nextId}\x1b[0m`);
      let newEnv = {};
      AI_CLI_CONFIGS[cliName].envKeys.forEach((k) => {
        const isOptional = k.includes('BASE_URL');
        const val = context.readLine.question(`${k}${isOptional ? ' (Optional)' : ''}: `).trim();
        if (val) newEnv[k] = val;
      });
      if (Object.keys(newEnv).length > 0) {
        createAccount(cliName, nextId, true);
        const accountRef = registerApiKeyAccount(fs, accountStorageDir, cliName, nextId, newEnv);
        if (!accountRef) throw new Error('account_ref_registration_failed');

        console.log(`\x1b[32m[Success]\x1b[0m API Keys bound to Sandbox ${nextId}!\n`);
        startCliPty(cliName, nextId, [], false, [nextId]);
      } else {
        console.log('\x1b[31mNo keys provided. Operation cancelled.\x1b[0m');
      }
      return;
    }
    const shouldLogin = createAccount(cliName, nextId);
    if (shouldLogin) {
      startCliPty(cliName, nextId, loginForwardArgs, true, ['login', ...loginForwardArgs]);
    } else {
      console.log(`\x1b[36m[aih]\x1b[0m Account 1 is ready. Run \`aih ${cliName} 1\` to start.`);
      processImpl.exit(0);
    }
    return;
  }

  let id = '1';
  if (idOrAction && /^\d+$/.test(idOrAction)) {
    id = idOrAction;
    const idStyleAction = args[2];
    if (idStyleAction && REMOVED_ACTIONS.has(idStyleAction)) {
      console.error(`\x1b[31m[aih]\x1b[0m Unknown subcommand: ${idStyleAction}`);
      showCliUsage(cliName);
      processImpl.exit(1);
      return;
    }
    if (idStyleAction && USAGE_ACTIONS.has(idStyleAction)) {
      const parsedQuery = parseUsageQueryArgs(args.slice(3));
      if (!parsedQuery.ok) {
        console.error(`\x1b[31m[aih] ${parsedQuery.error}\x1b[0m`);
        processImpl.exit(1);
        return;
      }
      if (!cliAccountExists(cliName, id)) {
        console.error(`\x1b[31m[aih] Account ID ${id} does not exist.\x1b[0m`);
        processImpl.exit(1);
        return;
      }
      const runPrintUsage = typeof printUsageSnapshotAsync === 'function'
        ? printUsageSnapshotAsync
        : printUsageSnapshot;
      Promise.resolve(runPrintUsage(cliName, id, { noCache: parsedQuery.noCache, preflight: parsedQuery.preflight }))
        .then(() => processImpl.exit(0))
        .catch((e) => {
          console.error(`\x1b[31m[aih] usage query failed: ${e.message}\x1b[0m`);
          processImpl.exit(1);
        });
      return;
    }
    forwardArgs = args.slice(2);
  } else {
    id = readDefaultCliAccountId(cliName) || id;
    if (idOrAction) {
      forwardArgs = args.slice(1);
    }
  }

  const accountScope = resolveCliAccount(cliName, id);
  const idNoBrowserOnly = /^\d+$/.test(String(idOrAction || ''))
    && hasNoBrowserFlag(forwardArgs)
    && stripNoBrowserFlag(forwardArgs).length === 0;
  const credentialHomeDir = accountStorageDir;
  const credentialAccountExists = Boolean(credentialHomeDir && cliAccountExists(cliName, id));
  const accountExists = credentialAccountExists;
  if (!accountExists) {
    if (idNoBrowserOnly) {
      const shouldLogin = createAccount(cliName, id);
      if (shouldLogin) {
        startCliPty(cliName, id, [NO_BROWSER_FLAG], true, [id, NO_BROWSER_FLAG]);
      } else {
        processImpl.exit(0);
      }
      return;
    }
    console.log(`\x1b[90mAccount ID ${id} for ${cliName} does not exist yet.\x1b[0m`);
    const ans = askYesNo(`\x1b[33mCreate Account ${id} and log in now?\x1b[0m`);
    if (ans === false) {
      console.log('Operation cancelled.');
      processImpl.exit(0);
      return;
    }
    const shouldLogin = createAccount(cliName, id);
    if (shouldLogin) {
      startCliPty(cliName, id, [], true, [id]);
      return;
    }
    processImpl.exit(0);
    return;
  }

  const { configured } = accountScope
    ? checkStatus(cliName, accountScope.accountRef)
    : { configured: false };
  if (idNoBrowserOnly) {
    if (!configured) {
      startCliPty(cliName, id, [NO_BROWSER_FLAG], true, [id, NO_BROWSER_FLAG]);
      return;
    }
    const nextId = getNextId(cliName);
    console.log(`\x1b[33m[Notice]\x1b[0m Account ${id} is already logged in. Creating Account ${nextId} for no-browser OAuth login.`);
    const shouldLogin = createAccount(cliName, nextId);
    if (shouldLogin) {
      startCliPty(cliName, nextId, [NO_BROWSER_FLAG], true, [nextId, NO_BROWSER_FLAG]);
    } else {
      processImpl.exit(0);
    }
    return;
  }
  if (!configured) {
    console.log(`\n\x1b[33m[Notice]\x1b[0m Account ${id} exists but seems to have no login state.`);
    const ans = askYesNo(`Do you want to run the login flow for Account ${id} now?`);
    if (ans !== false) {
      startCliPty(cliName, id, [], true, [id]);
      return;
    }
  }

  const status = accountScope
    ? checkStatus(cliName, accountScope.accountRef)
    : { configured: false };
  const isApiKeyMode = !!(status && status.accountName && status.accountName.startsWith('API Key'));

  if (!isApiKeyMode && typeof getAccountQuotaState === 'function') {
    const quotaState = getAccountQuotaState(cliName, accountScope.accountRef, { refreshSnapshot: true });
    if (quotaState && quotaState.quotaStatus === 'exhausted') {
      console.log(`\x1b[33m[Warning]\x1b[0m Account ${id} quota is exhausted.`);
      const ans = askYesNo('Still want to proceed?', false);
      if (ans === false) {
        console.log(`Use 'aih ${cliName} ls' to choose another account.`);
        processImpl.exit(0);
        return;
      }
    } else if (quotaState && quotaState.schedulableStatus === 'blocked_by_policy') {
      console.log(`\x1b[33m[Warning]\x1b[0m Account ${id} is blocked for server scheduling (${quotaState.schedulableReason || 'policy'}).`);
      const ans = askYesNo('Still want to proceed?', false);
      if (ans === false) {
        console.log(`Use 'aih ${cliName} ls' to choose another account.`);
        processImpl.exit(0);
        return;
      }
    }
  }

  startCliPty(cliName, id, forwardArgs, false, /^\d+$/.test(String(idOrAction || '')) ? [id, ...forwardArgs] : args.slice(1));
}

module.exports = {
  runAiCliCommandRouter
};
