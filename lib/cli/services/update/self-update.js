'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function readPackageInfo(deps = {}) {
  if (deps.packageInfo && deps.packageInfo.name && deps.packageInfo.version) {
    return {
      name: String(deps.packageInfo.name),
      version: String(deps.packageInfo.version)
    };
  }

  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const packageJsonPath = deps.packageJsonPath || pathImpl.resolve(__dirname, '../../../../package.json');
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
  log(`\x1b[36m[aih]\x1b[0m latest: ${info.latestVersion}`);
  log(`\x1b[36m[aih]\x1b[0m source: ${info.installSource}`);
  if (info.hasUpdate) {
    log('\x1b[33m[aih]\x1b[0m update available');
    return;
  }
  log('\x1b[32m[aih]\x1b[0m already up to date');
}

function buildManualHint(packageName) {
  return `npm install -g ${packageName}@latest`;
}

function createSelfUpdateService(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const spawnSyncImpl = deps.spawnSyncImpl || spawnSync;
  const processObj = deps.processObj || process;
  const log = deps.log || console.log;
  const error = deps.error || console.error;

  async function getUpdateInfo() {
    const packageInfo = readPackageInfo(deps);
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
  parseUpdateArgs
};
