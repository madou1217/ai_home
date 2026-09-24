'use strict';

// 为迁移工具拉起一个短生命周期的 Go Server：绑定系统分配的 loopback 端口（--port 0），
// 从 stdout 读取实际监听地址，密钥只经子进程 env 传递。与长驻 supervisor 相互独立。

const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const LISTEN_PATTERN = /aih-server listening on (http:\/\/[^\s]+)/;

function randomKey() {
  return crypto.randomBytes(32).toString('base64url');
}

async function startGoServerProcess(options = {}) {
  const spawn = options.spawn || defaultSpawn;
  const binaryPath = String(options.binaryPath || '');
  const aiHomeDir = String(options.aiHomeDir || '');
  if (!binaryPath || !aiHomeDir) throw new Error('go server process requires binaryPath and aiHomeDir');
  const managementKey = options.managementKey || randomKey();
  const clientKey = options.clientKey || randomKey();
  const child = spawn(binaryPath, ['--host', '127.0.0.1', '--port', '0'], {
    env: {
      ...process.env,
      ...(options.env || {}),
      AIH_HOME: aiHomeDir,
      AIH_SERVER_MANAGEMENT_KEY: managementKey,
      AIH_SERVER_CLIENT_KEY: clientKey
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });

  const baseUrl = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`go server did not start: ${stderr.trim()}`)), Number(options.startTimeoutMs) || 15000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const match = LISTEN_PATTERN.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`go server exited early (code=${code}): ${stderr.trim()}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  child.stdout.resume();

  function stop() {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_error) {} }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch (_error) { clearTimeout(timer); resolve(); }
    });
  }

  return { baseUrl, managementKey, clientKey, pid: child.pid, stop, stderr: () => stderr };
}

module.exports = {
  startGoServerProcess
};
