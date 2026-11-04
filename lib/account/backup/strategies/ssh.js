'use strict';

// SSH/SFTP 备份策略。
//
// 只用 ssh2（项目已有依赖），不依赖目标机的 rsync/scp：
//   - 先读远端 manifest.json，再按增量计划写账号文件；
//   - 写入是「临时文件 + rename」，避免远端留下半截 JSON；
//   - 主机指纹首次连接时记录（TOFU），之后配置里出现 hostKeyFingerprint 就必须匹配。
//
// 凭据只从本机私钥文件或环境变量读取；配置文件里不存密码。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('ssh2');

const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_KEEPALIVE_MS = 10000;

function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function joinRemote(base, relative) {
  const left = String(base || '').replace(/\/+$/, '');
  const right = String(relative || '').replace(/^\/+/, '');
  if (right.split('/').includes('..')) throw new Error('invalid_remote_path');
  return right ? `${left}/${right}` : left;
}

function resolveRemoteDir(remoteDir, home) {
  const value = String(remoteDir || '').trim();
  if (!value || value === '~') return home;
  if (value.startsWith('~/')) return joinRemote(home, value.slice(2));
  if (value.startsWith('/')) return value;
  // Windows OpenSSH 的绝对路径（C:/Users/...）。
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replace(/\\/g, '/');
  return joinRemote(home, value);
}

function createSshBackupStrategy(target, deps = {}) {
  const fsImpl = deps.fs || fs;
  const osImpl = deps.os || os;
  const ClientImpl = deps.Client || Client;
  const env = deps.env || process.env;
  const onHostKey = typeof deps.onHostKey === 'function' ? deps.onHostKey : null;

  let client = null;
  let sftp = null;
  let baseDir = '';
  let connected = false;
  let observedFingerprint = '';

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!sftp || typeof sftp[method] !== 'function') {
        reject(new Error('ssh_sftp_not_ready'));
        return;
      }
      sftp[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
    });
  }

  function buildConnectConfig() {
    const config = {
      host: target.host,
      port: Number(target.port) || 22,
      username: target.username,
      readyTimeout: Number(deps.readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: Number(deps.keepaliveMs) || DEFAULT_KEEPALIVE_MS,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hash) => {
        observedFingerprint = String(hash || '').toLowerCase();
        if (target.hostKeyFingerprint) return observedFingerprint === target.hostKeyFingerprint;
        return true;
      }
    };
    const identityFile = expandHome(target.identityFile);
    if (identityFile) {
      if (!fsImpl.existsSync(identityFile)) throw new Error(`SSH 私钥不存在：${identityFile}`);
      config.privateKey = fsImpl.readFileSync(identityFile);
    }
    if (target.passwordEnv) {
      const password = env[target.passwordEnv];
      if (password) config.password = String(password);
    }
    if (!config.privateKey && !config.password) {
      throw new Error(`备份目标 ${target.id} 没有可用凭据：用 --key 指定私钥，或配置 passwordEnv`);
    }
    return config;
  }

  async function ensureDir(directory) {
    const absolute = String(directory).startsWith('/');
    const parts = String(directory).split('/').filter(Boolean);
    let current = absolute ? '' : '.';
    for (const part of parts) {
      current = current === '' ? `/${part}` : `${current}/${part}`;
      try {
        await call('mkdir', current);
      } catch (error) {
        const stat = await call('stat', current).catch(() => null);
        if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) continue;
        throw error;
      }
    }
  }

  async function connect() {
    if (connected) return;
    const config = buildConnectConfig();
    await new Promise((resolve, reject) => {
      const nextClient = new ClientImpl();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { nextClient.end(); } catch (_ignored) {}
        reject(error);
      };
      nextClient.on('ready', () => {
        nextClient.sftp((error, nextSftp) => {
          if (error) {
            fail(error);
            return;
          }
          settled = true;
          client = nextClient;
          sftp = nextSftp;
          connected = true;
          resolve();
        });
      });
      nextClient.on('error', fail);
      nextClient.on('close', () => {
        if (!settled) fail(new Error('ssh_connection_closed'));
      });
      try {
        nextClient.connect(config);
      } catch (error) {
        fail(error);
      }
    });
    const home = await call('realpath', '.');
    baseDir = resolveRemoteDir(target.remoteDir, home);
    await ensureDir(baseDir);
    if (!target.hostKeyFingerprint && observedFingerprint && onHostKey) {
      try { onHostKey(observedFingerprint); } catch (_ignored) { /* 记录失败不影响本次备份 */ }
    }
  }

  async function readFile(relativePath) {
    await connect();
    const remote = joinRemote(baseDir, relativePath);
    try {
      const content = await call('readFile', remote);
      return Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    } catch (error) {
      // SFTP status 2 = NO_SUCH_FILE：远端还没有这个文件，不是错误。
      if (Number(error && error.code) === 2) return null;
      throw error;
    }
  }

  async function writeFile(relativePath, content, options = {}) {
    await connect();
    const remote = joinRemote(baseDir, relativePath);
    const directory = path.posix.dirname(remote);
    await ensureDir(directory);
    const temp = `${remote}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
    try {
      await call('writeFile', temp, Buffer.from(String(content), 'utf8'), { mode });
      try {
        await call('rename', temp, remote);
      } catch (error) {
        // Windows OpenSSH 的 SFTP 不允许 rename 覆盖已存在文件。
        await call('unlink', remote).catch(() => {});
        await call('rename', temp, remote);
      }
    } catch (error) {
      await call('unlink', temp).catch(() => {});
      throw error;
    }
  }

  async function statFile(relativePath) {
    await connect();
    try {
      return await call('stat', joinRemote(baseDir, relativePath));
    } catch (error) {
      if (Number(error && error.code) === 2) return null;
      throw error;
    }
  }

  function close() {
    if (client) {
      try { client.end(); } catch (_ignored) {}
    }
    client = null;
    sftp = null;
    connected = false;
  }

  return {
    id: target.id,
    strategy: 'ssh',
    connect,
    readFile,
    writeFile,
    statFile,
    close,
    get baseDir() { return baseDir; },
    get hostKeyFingerprint() { return observedFingerprint; }
  };
}

module.exports = {
  createSshBackupStrategy,
  expandHome,
  joinRemote,
  resolveRemoteDir
};
