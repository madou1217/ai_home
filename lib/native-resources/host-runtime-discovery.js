'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const semver = require('semver');
const { getExternalHarness } = require('../harness/catalog');
const { runProcess } = require('../../scripts/process-runner');

function directories(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (_) { return []; }
}

// Inspect only this descriptor's package, never scan arbitrary user files.
function findRuntimePackage(descriptor, options = {}) {
  const harness = getExternalHarness(descriptor.harness);
  if (!harness) return null;
  const packageName = harness.packageName;
  const candidates = [];
  const explicit = options.hostRuntimePackages?.[descriptor.host];
  if (explicit) candidates.push(path.resolve(explicit));
  else if (options.hostHomeDir) {
    const home = options.hostHomeDir;
    try { candidates.push(path.dirname(createRequire(path.join(home, 'package.json')).resolve(`${packageName}/package.json`))); } catch (_) {}
    candidates.push(path.resolve(path.dirname(process.execPath), '../lib/node_modules', packageName));
    const stores = [path.join(home, 'Library/pnpm/store'), path.join(home, '.local/share/pnpm/store'), path.join(home, 'AppData/Local/pnpm/store')];
    if (process.env.PNPM_HOME) stores.unshift(path.join(process.env.PNPM_HOME, 'store'));
    for (const store of new Set(stores)) {
      for (const layout of directories(store).filter(name => /^v\d+$/.test(name))) {
        const packages = path.join(store, layout, 'links', packageName);
        const versions = directories(packages).filter(version => semver.valid(version)).sort(semver.rcompare);
        for (const version of versions) {
          for (const content of directories(path.join(packages, version))) candidates.push(path.join(packages, version, content, 'node_modules', packageName));
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const root = fs.realpathSync(candidate);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const entry = path.join(root, descriptor.entry);
      if (pkg.name === packageName && semver.valid(pkg.version) && fs.statSync(entry).isFile()) return { packageName, packageDir: root, version: pkg.version, entry };
    } catch (_) {}
  }
  return null;
}

function hostProbeArgs(descriptor, runtime) {
  return descriptor.cliExport
    ? ['--input-type=module', '-e', `process.argv = [process.argv[0], ${JSON.stringify(runtime.entry)}, '--version']; const cli = await import(${JSON.stringify(pathToFileURL(runtime.entry).href)}); await cli[${JSON.stringify(descriptor.cliExport)}]();`]
    : [runtime.entry, '--version'];
}

function hostProbeResult(runtime, status, stdout, errorCode) {
  const versionObserved = String(stdout || '').trim();
  return status === 0 && versionObserved.includes(runtime.version)
    ? { ...runtime, available: true, versionObserved }
    : { ...runtime, available: false, reason: errorCode || 'native_runtime_probe_failed' };
}

function probeHostRuntime(descriptor, options = {}) {
  const runtime = findRuntimePackage(descriptor, options);
  if (!runtime) return { available: false, reason: 'native_runtime_package_not_found' };
  if (options.probeRuntime === false) return { ...runtime, available: false, reason: 'native_runtime_not_probed' };
  const result = spawnSync(process.execPath, hostProbeArgs(descriptor, runtime), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 65536 });
  return hostProbeResult(runtime, result.status, result.stdout, result.error?.code);
}

// Non-blocking variant for request paths (WebUI): same result shape as probeHostRuntime.
async function probeHostRuntimeAsync(descriptor, options = {}) {
  const runtime = findRuntimePackage(descriptor, options);
  if (!runtime) return { available: false, reason: 'native_runtime_package_not_found' };
  if (options.probeRuntime === false) return { ...runtime, available: false, reason: 'native_runtime_not_probed' };
  const result = await runProcess(process.execPath, hostProbeArgs(descriptor, runtime), { timeoutMs: 5000, maxOutput: 65536, killGraceMs: 0 });
  return hostProbeResult(runtime, result.timedOut ? null : result.status, result.stdout, result.timedOut ? 'ETIMEDOUT' : (result.error || undefined));
}

module.exports = { findRuntimePackage, probeHostRuntime, probeHostRuntimeAsync };
