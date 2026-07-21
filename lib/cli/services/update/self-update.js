'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MACOS_BACKGROUND_PLIST = 'com.clawdcodex.ai_home.plist';
const LEGACY_MACOS_SERVER_PLIST = 'com.aih.server.plist';

function parseUpdateArgs(args) {
  const tokens = Array.isArray(args) ? args : [];
  const options = {
    checkOnly: false,
    dryRun: false,
    force: false
  };

  for (const rawToken of tokens) {
    const token = String(rawToken || '').trim();
    if (!token) continue;
    if (token === '--check') {
      options.checkOnly = true;
      continue;
    }
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    return {
      ok: false,
      error: `Unknown update arg: ${token}`
    };
  }

  return { ok: true, options };
}

function detectInstallSource(packageName, processObj = {}) {
  const env = processObj.env || {};
  const scriptPath = String((Array.isArray(processObj.argv) ? processObj.argv[1] : '') || '').replace(/\\/g, '/');
  const npmExecPath = String(env.npm_execpath || '').replace(/\\/g, '/');
  const userAgent = String(env.npm_config_user_agent || '');
  const packageMarker = `/node_modules/${packageName}/`;

  if (userAgent.startsWith('npm/')) {
    return 'npm';
  }
  if (npmExecPath.includes('/npm-cli.js')) {
    return 'npm';
  }
  if (scriptPath.includes('/pnpm/') || scriptPath.includes('/yarn/') || scriptPath.includes('/bun/')) {
    return 'unknown';
  }
  if (scriptPath.includes(packageMarker)) {
    return 'npm';
  }
  return 'unknown';
}

function resolvePackageJsonPath(deps = {}, pathImpl = path) {
  return deps.packageJsonPath || pathImpl.resolve(__dirname, '../../../../package.json');
}

function isPathWithin(rootPath, candidatePath, pathImpl = path) {
  const relativePath = pathImpl.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith(`..${pathImpl.sep}`)
      && relativePath !== '..'
      && !pathImpl.isAbsolute(relativePath));
}

function detectSourceLinkInstall(deps = {}, processObj = process) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const entryFilePath = String(
    deps.cliEntryFilePath
      || (Array.isArray(processObj.argv) ? processObj.argv[1] : '')
      || ''
  ).trim();
  if (!entryFilePath) return null;

  try {
    const packageJsonPath = fsImpl.realpathSync(resolvePackageJsonPath(deps, pathImpl));
    const sourceRoot = pathImpl.dirname(packageJsonPath);
    const entryRealPath = fsImpl.realpathSync(entryFilePath);
    if (!isPathWithin(sourceRoot, entryRealPath, pathImpl)) return null;
    if (!fsImpl.existsSync(pathImpl.join(sourceRoot, '.git'))) return null;
    return { sourceRoot };
  } catch (_error) {
    return null;
  }
}

function readSourceCommit(sourceRoot, spawnSyncImpl) {
  try {
    const result = spawnSyncImpl(
      'git',
      ['-C', sourceRoot, 'rev-parse', '--short=12', 'HEAD'],
      {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    if (!result || result.status !== 0) return 'unknown';
    return String(result.stdout || '').trim() || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function readPackageInfo(deps = {}) {
  if (deps.packageInfo && deps.packageInfo.name && deps.packageInfo.version) {
    return {
      name: String(deps.packageInfo.name),
      version: String(deps.packageInfo.version)
    };
  }

  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const packageJsonPath = resolvePackageJsonPath(deps, pathImpl);
  const content = fsImpl.readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(content);
  return {
    name: String(parsed.name || ''),
    version: String(parsed.version || '')
  };
}

async function fetchLatestVersion(packageName, fetchImpl) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response || !response.ok) {
    const status = response && typeof response.status !== 'undefined' ? response.status : 'unknown';
    throw new Error(`Failed to query npm registry (status: ${status}).`);
  }

  const payload = await response.json();
  const version = String((payload && payload.version) || '').trim();
  if (!version) {
    throw new Error('npm registry did not return a valid latest version.');
  }
  return version;
}

function renderCheckResult(log, info) {
  log(`\x1b[36m[aih]\x1b[0m current: ${info.currentVersion}`);
  log(`\x1b[36m[aih]\x1b[0m source: ${info.installSource}`);
  if (info.installSource === 'source-link') {
    log(`\x1b[36m[aih]\x1b[0m source path: ${info.sourceRoot}`);
    log(`\x1b[36m[aih]\x1b[0m commit: ${info.sourceCommit}`);
    log('\x1b[90m[aih]\x1b[0m npm registry check skipped for source-linked install');
    return;
  }
  log(`\x1b[36m[aih]\x1b[0m latest: ${info.latestVersion}`);
  if (info.hasUpdate) {
    log('\x1b[33m[aih]\x1b[0m update available');
    return;
  }
  log('\x1b[32m[aih]\x1b[0m already up to date');
}

function buildManualHint(packageName) {
  return `npm install -g ${packageName}@latest`;
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function renderSourceLinkManualHint(log, info) {
  log(`\x1b[90m[Hint]\x1b[0m Update the source checkout manually:`);
  log(`  git -C ${shellQuote(info.sourceRoot)} pull --ff-only`);
  log('  aih server restart');
}

function hasInstalledMacosBackgroundService(deps = {}) {
  const processObj = deps.processObj || process;
  if (processObj.platform !== 'darwin') return false;
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const homeDir = String(
    deps.hostHomeDir
      || (processObj.env && (processObj.env.HOME || processObj.env.USERPROFILE))
      || ''
  ).trim();
  if (!homeDir) return false;
  const launchAgentsDir = pathImpl.join(homeDir, 'Library', 'LaunchAgents');
  try {
    return fsImpl.readdirSync(launchAgentsDir).some((entry) => {
      const name = String(entry || '');
      return name === MACOS_BACKGROUND_PLIST
        || name === LEGACY_MACOS_SERVER_PLIST
        || (name.startsWith('com.clawdcodex.ai_home.') && name.endsWith('.plist'));
    });
  } catch (_error) {
    return false;
  }
}

function reloadInstalledMacosBackgroundService(spawnSyncImpl, processObj, deps = {}) {
  const entryFilePath = String(
    deps.cliEntryFilePath
      || (Array.isArray(processObj.argv) ? processObj.argv[1] : '')
      || ''
  ).trim();
  if (!entryFilePath) return { status: 1 };
  return spawnSyncImpl(
    String(processObj.execPath || process.execPath),
    [entryFilePath, 'server', 'autostart', 'install'],
    { stdio: 'inherit', shell: false }
  );
}

function createSelfUpdateService(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const spawnSyncImpl = deps.spawnSyncImpl || spawnSync;
  const processObj = deps.processObj || process;
  const log = deps.log || console.log;
  const error = deps.error || console.error;

  async function getUpdateInfo() {
    const packageInfo = readPackageInfo(deps);
    const sourceLink = detectSourceLinkInstall(deps, processObj);
    if (sourceLink) {
      return {
        packageName: packageInfo.name,
        currentVersion: packageInfo.version,
        latestVersion: null,
        installSource: 'source-link',
        hasUpdate: null,
        sourceRoot: sourceLink.sourceRoot,
        sourceCommit: readSourceCommit(sourceLink.sourceRoot, spawnSyncImpl)
      };
    }
    const latestVersion = await fetchLatestVersion(packageInfo.name, fetchImpl);
    const installSource = detectInstallSource(packageInfo.name, processObj);
    return {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      latestVersion,
      installSource,
      hasUpdate: packageInfo.version !== latestVersion
    };
  }

  async function runUpdateCommand(args = []) {
    const parsed = parseUpdateArgs(args);
    if (!parsed.ok) {
      error(`\x1b[31m[aih] ${parsed.error}\x1b[0m`);
      log('\x1b[90mUsage:\x1b[0m aih update [--check] [--dry-run] [--force]');
      return 1;
    }

    const options = parsed.options;
    let info;
    try {
      info = await getUpdateInfo();
    } catch (updateError) {
      error(`\x1b[31m[aih] update check failed: ${updateError.message}\x1b[0m`);
      return 1;
    }

    renderCheckResult(log, info);
    if (options.checkOnly) {
      return 0;
    }

    if (info.installSource === 'source-link') {
      error('\x1b[31m[aih] Automatic update skipped for source-linked install.\x1b[0m');
      renderSourceLinkManualHint(log, info);
      return 1;
    }

    if (!info.hasUpdate && !options.force) {
      return 0;
    }

    const manualHint = buildManualHint(info.packageName);
    if (info.installSource !== 'npm') {
      error('\x1b[31m[aih] Unable to determine a safe auto-update source.\x1b[0m');
      log(`\x1b[90m[Hint]\x1b[0m Run manually: ${manualHint}`);
      return 1;
    }

    const installArgs = ['install', '-g', `${info.packageName}@latest`];
    if (options.dryRun) {
      log(`\x1b[36m[aih]\x1b[0m dry-run: npm ${installArgs.join(' ')}`);
      return 0;
    }

    log(`\x1b[36m[aih]\x1b[0m running: npm ${installArgs.join(' ')}`);
    const result = spawnSyncImpl('npm', installArgs, {
      stdio: 'inherit',
      shell: processObj.platform === 'win32'
    });
    if (!result || result.status !== 0) {
      const code = result && typeof result.status === 'number' ? result.status : 1;
      error(`\x1b[31m[aih] update failed. You can retry manually: ${manualHint}\x1b[0m`);
      return code || 1;
    }

    if (hasInstalledMacosBackgroundService({ ...deps, processObj })) {
      log('\x1b[36m[aih]\x1b[0m migrating installed macOS background services');
      const migrated = reloadInstalledMacosBackgroundService(spawnSyncImpl, processObj, deps);
      if (!migrated || migrated.status !== 0) {
        const code = migrated && typeof migrated.status === 'number' ? migrated.status : 1;
        error('\x1b[31m[aih] update installed, but background service migration failed. Run: aih server autostart install\x1b[0m');
        return code || 1;
      }
    }

    log('\x1b[32m[aih]\x1b[0m update completed');
    return 0;
  }

  return {
    getUpdateInfo,
    runUpdateCommand
  };
}

module.exports = {
  createSelfUpdateService,
  detectInstallSource,
  hasInstalledMacosBackgroundService,
  parseUpdateArgs
};
