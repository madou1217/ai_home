'use strict';

const { spawn } = require('node:child_process');

const MAX_CAPTURE_BYTES = 64 * 1024;

function boundedAppend(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length <= MAX_CAPTURE_BYTES
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_BYTES);
}

function containsSecret(value, secret) {
  return typeof value === 'string' && value.includes(secret);
}

function redactText(value, secret) {
  return String(value || '')
    .split(secret).join('[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [REDACTED]')
    .replace(/("(?:managementKey|management_key|AIH_DESKTOP_SMOKE_MANAGEMENT_KEY)"\s*:\s*")[^"]*(")/giu, '$1[REDACTED]$2');
}

function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} 执行超时`));
    }, options.timeoutMs || 15_000);
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`${command} 退出码 ${exitCode}: ${(stderr || stdout).trim().slice(-1_000)}`));
        return;
      }
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(options.input || undefined);
  });
}

module.exports = {
  boundedAppend,
  containsSecret,
  redactText,
  runCaptured,
};
