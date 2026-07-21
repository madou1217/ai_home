'use strict';

const path = require('node:path');

const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const WINDOWS_COMMAND_EXTENSIONS = new Set(['.cmd', '.bat']);
const DEFAULT_PROVIDER_VERSION_PROBE_TIMEOUT_MS = 1000;

function versionInvocation(executablePath, filePrefix, options) {
  const extension = path.extname(executablePath).toLowerCase();
  if (options.platform !== 'win32') {
    return unixVersionInvocation(executablePath, extension, filePrefix, options);
  }
  return windowsVersionInvocation(executablePath, extension, options);
}

function unixVersionInvocation(executablePath, extension, filePrefix, options) {
  if (String(filePrefix || '').startsWith('#!')) {
    return { command: executablePath, args: ['--version'] };
  }
  return scriptVersionInvocation(executablePath, extension, options);
}

function windowsVersionInvocation(executablePath, extension, options) {
  if (WINDOWS_COMMAND_EXTENSIONS.has(extension)) {
    const command = options.env.COMSPEC || options.env.ComSpec || 'cmd.exe';
    return { command, args: ['/d', '/s', '/c', `"${executablePath}" --version`] };
  }
  if (extension === '.ps1') {
    return {
      command: options.powershellExecutable,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executablePath, '--version']
    };
  }
  return scriptVersionInvocation(executablePath, extension, options);
}

function scriptVersionInvocation(executablePath, extension, options) {
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return { command: options.nodeExecutable, args: [executablePath, '--version'] };
  }
  return { command: executablePath, args: ['--version'] };
}

function versionFromOutput(stdout, stderr) {
  const output = normalizeText(stdout) || normalizeText(stderr);
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function probeProviderRuntimeVersion(executablePath, filePrefix, options) {
  const invocation = versionInvocation(executablePath, filePrefix, options);
  const timeout = versionProbeTimeout(options.versionProbeTimeoutMs);
  return new Promise((resolve) => {
    let child;
    try {
      child = options.spawn(invocation.command, invocation.args, {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        windowsHide: true
      });
    } catch (_error) {
      resolve('');
      return;
    }
    observeVersionProcess(child, timeout, resolve);
  });
}

function observeVersionProcess(child, timeout, resolve) {
  if (!child || typeof child.once !== 'function') {
    resolve('');
    return;
  }
  let settled = false;
  let stdout = '';
  let stderr = '';
  let timer;
  const finish = (version) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(version);
  };
  timer = setTimeout(() => {
    tryKill(child);
    finish('');
  }, timeout);
  collectOutput(child.stdout, (chunk) => { stdout += chunk; });
  collectOutput(child.stderr, (chunk) => { stderr += chunk; });
  child.once('error', () => finish(''));
  child.once('close', (code, signal) => {
    const succeeded = code === 0 && !signal && !child.killed;
    finish(succeeded ? versionFromOutput(stdout, stderr) : '');
  });
}

function collectOutput(stream, append) {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('data', (chunk) => append(String(chunk)));
}

function tryKill(child) {
  if (!child || typeof child.kill !== 'function' || child.killed) return;
  try {
    child.kill();
  } catch (_error) {}
}

function versionProbeTimeout(value) {
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout > 0
    ? timeout
    : DEFAULT_PROVIDER_VERSION_PROBE_TIMEOUT_MS;
}

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  DEFAULT_PROVIDER_VERSION_PROBE_TIMEOUT_MS,
  probeProviderRuntimeVersion,
  versionInvocation
};
