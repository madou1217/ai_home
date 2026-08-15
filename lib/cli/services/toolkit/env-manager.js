'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

/**
 * EnvManager: manages language environments like Node.js (nvm, fnm, volta) and Python (pyenv, conda, venv).
 * Single Responsibility: Read and query runtime versions, manager tools, and active environment profiles.
 */

function resolveHostHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  const processObj = options.processObj || process;
  try {
    return resolveHostHomeDir({
      env: processObj.env || process.env || {},
      platform: processObj.platform || process.platform,
      os: options.os || os
    });
  } catch (_error) {
    return String(processObj.env && (processObj.env.USERPROFILE || processObj.env.HOME) || '').trim();
  }
}

function execCommand(cmd, args = []) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  } catch (_e) {
    // Ignore error
  }
  return '';
}

/**
 * Detect Node.js environment: current version, path, package managers, and nvm/fnm/volta installed versions.
 */
function detectNodeEnvironment(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const hostHome = resolveHostHome(options);

  const nodeVersion = process.version || execCommand('node', ['-v']);
  const nodePathVal = process.execPath || execCommand('which', ['node']);

  // Package managers
  const npmVersion = execCommand('npm', ['-v']);
  const pnpmVersion = execCommand('pnpm', ['-v']);
  const yarnVersion = execCommand('yarn', ['-v']);
  const bunVersion = execCommand('bun', ['-v']);

  // Version managers detection
  const managers = [];

  // nvm: check ~/.nvm/versions/node
  const nvmVersionsDir = pathImpl.join(hostHome, '.nvm', 'versions', 'node');
  const nvmVersions = [];
  if (fsImpl.existsSync(nvmVersionsDir)) {
    try {
      const entries = fsImpl.readdirSync(nvmVersionsDir);
      for (const entry of entries) {
        if (entry.startsWith('v')) {
          nvmVersions.push(entry);
        }
      }
    } catch (_e) {}
    managers.push({
      name: 'nvm',
      installed: true,
      path: pathImpl.join(hostHome, '.nvm'),
      versions: nvmVersions
    });
  }

  // fnm: check ~/.fnm or fnm command
  const fnmVersionsDir = pathImpl.join(hostHome, '.fnm', 'current');
  const fnmCmd = execCommand('fnm', ['--version']);
  if (fnmCmd || fsImpl.existsSync(fnmVersionsDir)) {
    managers.push({
      name: 'fnm',
      installed: true,
      version: fnmCmd,
      path: pathImpl.join(hostHome, '.fnm')
    });
  }

  // volta: check ~/.volta or volta command
  const voltaCmd = execCommand('volta', ['-v']);
  if (voltaCmd || fsImpl.existsSync(pathImpl.join(hostHome, '.volta'))) {
    managers.push({
      name: 'volta',
      installed: true,
      version: voltaCmd,
      path: pathImpl.join(hostHome, '.volta')
    });
  }

  return {
    name: 'Node.js',
    currentVersion: nodeVersion || '',
    activePath: nodePathVal || '',
    packageManagers: {
      npm: npmVersion || null,
      pnpm: pnpmVersion || null,
      yarn: yarnVersion || null,
      bun: bunVersion || null
    },
    versionManagers: managers,
    installedVersions: nvmVersions.length ? nvmVersions : [nodeVersion].filter(Boolean)
  };
}

/**
 * Detect Python environment: current version, path, pip, and pyenv/conda/venv
 */
function detectPythonEnvironment(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const hostHome = resolveHostHome(options);

  const pythonVersion = execCommand('python3', ['--version']) || execCommand('python', ['--version']);
  const pythonPathVal = execCommand('which', ['python3']) || execCommand('which', ['python']);
  const pipVersion = execCommand('pip3', ['--version']) || execCommand('pip', ['--version']);

  const managers = [];

  // pyenv: check ~/.pyenv/versions
  const pyenvDir = pathImpl.join(hostHome, '.pyenv', 'versions');
  const pyenvVersions = [];
  if (fsImpl.existsSync(pyenvDir)) {
    try {
      const entries = fsImpl.readdirSync(pyenvDir);
      for (const entry of entries) {
        if (!entry.startsWith('.')) {
          pyenvVersions.push(entry);
        }
      }
    } catch (_e) {}
    managers.push({
      name: 'pyenv',
      installed: true,
      path: pathImpl.join(hostHome, '.pyenv'),
      versions: pyenvVersions
    });
  }

  // conda: check conda command
  const condaVersion = execCommand('conda', ['--version']);
  if (condaVersion) {
    managers.push({
      name: 'conda',
      installed: true,
      version: condaVersion
    });
  }

  return {
    name: 'Python',
    currentVersion: pythonVersion || '',
    activePath: pythonPathVal || '',
    pip: pipVersion ? pipVersion.split(' ')[1] || pipVersion : null,
    versionManagers: managers,
    installedVersions: pyenvVersions.length ? pyenvVersions : [pythonVersion].filter(Boolean)
  };
}

/**
 * Get all environment summaries
 */
function getEnvironmentsSummary(options = {}) {
  return {
    ok: true,
    environments: {
      node: detectNodeEnvironment(options),
      python: detectPythonEnvironment(options)
    }
  };
}

module.exports = {
  detectNodeEnvironment,
  detectPythonEnvironment,
  getEnvironmentsSummary
};
