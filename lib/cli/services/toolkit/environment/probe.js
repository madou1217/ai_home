'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { resolveClientPlatform } = require('../../../../runtime/client-platform');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const { resolveHostHomeDir } = require('../../../../runtime/host-home');

function resolvePlatform(options = {}) {
  return resolveClientPlatform(options);
}

function resolvePath(options = {}) {
  return resolvePlatformPath(resolvePlatform(options), options.path || nodePath);
}

function resolveHostHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || {};
  try {
    return resolveHostHomeDir({
      env,
      platform: processObj.platform || process.platform,
      os: options.os || nodeOs
    });
  } catch (_error) {
    return String(env.USERPROFILE || env.HOME || '').trim();
  }
}

function execCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  const timeoutMs = Math.min(Math.max(Number(options.probeTimeoutMs) || 3000, 250), 30_000);
  try {
    const result = spawnSyncImpl(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: options.env || (options.processObj || process).env
    });
    const stdout = String(result && result.stdout || '').trim();
    const stderr = String(result && result.stderr || '').trim();
    return {
      ok: Boolean(result && result.status === 0),
      status: result && Number.isInteger(result.status) ? result.status : null,
      stdout,
      stderr,
      value: result && result.status === 0 ? (stdout || stderr) : ''
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: String(error && error.message || error),
      value: ''
    };
  }
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function resolveExecutablePath(command, options = {}) {
  const resolver = resolvePlatform(options) === 'windows' ? 'where.exe' : 'which';
  return firstLine(execCommand(resolver, [command], options).value);
}

function listDirectories(fsImpl, directory) {
  try {
    if (!directory || !fsImpl.existsSync(directory)) return [];
    return fsImpl.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch (_error) {
    return [];
  }
}

function probeNvm(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePath(options);
  const root = pathImpl.join(resolveHostHome(options), '.nvm');
  const versions = listDirectories(fsImpl, pathImpl.join(root, 'versions', 'node'));
  return {
    installed: fsImpl.existsSync(root),
    version: versions.length ? `${versions.length} 个 Node.js 版本` : '',
    executablePath: root,
    managedVersions: versions
  };
}

function probePyenv(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePath(options);
  const root = pathImpl.join(resolveHostHome(options), '.pyenv');
  const commandProbe = execCommand('pyenv', ['--version'], options);
  const versions = listDirectories(fsImpl, pathImpl.join(root, 'versions'));
  return {
    installed: commandProbe.ok || fsImpl.existsSync(root),
    version: commandProbe.value || (versions.length ? `${versions.length} 个 Python 版本` : ''),
    executablePath: resolveExecutablePath('pyenv', options) || root,
    managedVersions: versions
  };
}

function probeConda(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePath(options);
  const home = resolveHostHome(options);
  const commandProbe = execCommand('conda', ['--version'], options);
  const roots = [
    pathImpl.join(home, 'miniconda3'),
    pathImpl.join(home, 'anaconda3')
  ];
  const root = roots.find((candidate) => fsImpl.existsSync(candidate)) || '';
  const envRoots = [
    ...(root ? [pathImpl.join(root, 'envs')] : []),
    pathImpl.join(home, '.conda', 'envs')
  ];
  const managedVersions = Array.from(new Set(envRoots.flatMap((directory) => listDirectories(fsImpl, directory))));
  return {
    installed: commandProbe.ok || Boolean(root),
    version: commandProbe.value || (root ? '已安装' : ''),
    executablePath: resolveExecutablePath('conda', options) || root,
    managedVersions
  };
}

function probeEnvironmentTool(tool, options = {}) {
  if (!tool || typeof tool !== 'object') return { installed: false, version: '', executablePath: '', managedVersions: [] };
  if (tool.probe && tool.probe.kind === 'nvm') return probeNvm(options);
  if (tool.probe && tool.probe.kind === 'pyenv') return probePyenv(options);
  if (tool.probe && tool.probe.kind === 'conda') return probeConda(options);
  const command = String(tool.probe && tool.probe.command || '').trim();
  if (!command) return { installed: false, version: '', executablePath: '', managedVersions: [] };
  const result = execCommand(command, tool.probe.args || ['--version'], options);
  return {
    installed: result.ok,
    version: firstLine(result.value),
    executablePath: result.ok ? resolveExecutablePath(command, options) : '',
    managedVersions: []
  };
}

function detectNodeEnvironment(options = {}) {
  const versionProbe = execCommand('node', ['--version'], options);
  const npmProbe = execCommand('npm', ['--version'], options);
  const packageManagerVersion = firstLine(npmProbe.value);
  return {
    id: 'node',
    name: 'Node.js',
    installed: versionProbe.ok,
    currentVersion: firstLine(versionProbe.value),
    activePath: versionProbe.ok ? resolveExecutablePath('node', options) : '',
    packageManagerVersion,
    packageManagers: { npm: packageManagerVersion || null },
    scope: 'aih-server-process-path',
    source: 'command-probe',
    probeStatus: versionProbe.ok ? 'available' : (versionProbe.status === null ? 'error' : 'unavailable')
  };
}

function detectPythonEnvironment(options = {}) {
  const python3 = execCommand('python3', ['--version'], options);
  const python = python3.ok ? python3 : execCommand('python', ['--version'], options);
  const command = python3.ok ? 'python3' : 'python';
  const pip3 = execCommand('pip3', ['--version'], options);
  const pip = pip3.ok ? pip3 : execCommand('pip', ['--version'], options);
  return {
    id: 'python',
    name: 'Python',
    installed: python.ok,
    currentVersion: firstLine(python.value),
    activePath: python.ok ? resolveExecutablePath(command, options) : '',
    packageManagerVersion: firstLine(pip.value).split(/\s+/)[1] || firstLine(pip.value),
    scope: 'aih-server-process-path',
    source: 'command-probe',
    probeStatus: python.ok ? 'available' : (python.status === null ? 'error' : 'unavailable')
  };
}

module.exports = {
  detectNodeEnvironment,
  detectPythonEnvironment,
  execCommand,
  probeConda,
  probeEnvironmentTool,
  probeNvm,
  probePyenv,
  resolveExecutablePath,
  resolveHostHome,
  resolvePath,
  resolvePlatform
};
