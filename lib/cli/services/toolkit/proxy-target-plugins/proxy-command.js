'use strict';

const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');

// 一次命令的结果形状与同步版保持一致（ok/status/stdout/stderr），
// 调用方从 execCommand 迁移到 execCommandAsync 时不需要改解析逻辑。
function normalizeResult(status, stdout, stderr) {
  return {
    ok: status === 0,
    status: Number.isInteger(status) ? status : null,
    stdout: String(stdout || '').trim(),
    stderr: String(stderr || '').trim()
  };
}

/**
 * 异步执行一个命令，结果形状与 execCommand 完全一致。
 *
 * 为什么必须有这一条：`spawnSync` 会阻塞 Node 主线程，WebUI 的诊断类接口
 * （proxy / environments / mirrors / apps）一次要串行跑 10+ 个命令，
 * 阻塞期间**所有** HTTP 请求（含 SSE 心跳与 /healthz）一起排队。
 * 读路径一律走这里；真正需要同步语义的 CLI 交互仍可用 execCommand。
 */
function execCommandAsync(cmd, args = [], options = {}) {
  const spawnImpl = options.spawn || nodeSpawn;
  const timeoutMs = options.commandTimeoutMs || 4000;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnImpl(cmd, args, { windowsHide: true, ...(options.spawnOptions || {}) });
    } catch (error) {
      finish({ ok: false, status: null, stdout: '', stderr: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    // 诊断输出（git config / scutil / networksetup）都是小文本；设上限防止异常进程撑爆内存。
    const maxBytes = Number(options.maxOutputBytes) || 256 * 1024;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (stdout.length < maxBytes) stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxBytes) stderr += chunk;
      });
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_error) { /* 进程可能已退出 */ }
      finish({ ok: false, status: null, stdout, stderr: stderr || `command_timeout_${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (error) => {
      // ENOENT 等启动失败：语义同同步版的 { status: null }。
      finish({ ok: false, status: null, stdout, stderr: error.message });
    });
    child.on('close', (code, signal) => {
      finish(normalizeResult(
        Number.isInteger(code) ? code : null,
        stdout,
        stderr || (signal ? `signal_${signal}` : '')
      ));
    });
  });
}

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs || 4000,
      windowsHide: true
    });
    return {
      ok: Boolean(res) && res.status === 0,
      status: res && Number.isInteger(res.status) ? res.status : null,
      stdout: String(res && res.stdout || '').trim(),
      stderr: String(res && res.stderr || '').trim()
    };
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: e.message };
  }
}

function parseProxyUrl(proxyUrl, { localHttpOnly = false } = {}) {
  const raw = String(proxyUrl || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    const protocols = localHttpOnly ? ['http:', 'https:'] : ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (localHttpOnly) {
      const host = parsed.hostname.toLowerCase();
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return null;
      if (!parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function summarizeOperations(operations) {
  const failed = operations.find((operation) => !operation.ok);
  return {
    ok: !failed,
    error: failed ? 'proxy_config_failed' : null,
    message: failed ? (failed.stderr || `${failed.key} 配置失败`) : '',
    operations
  };
}

module.exports = {
  execCommand,
  execCommandAsync,
  parseProxyUrl,
  summarizeOperations
};
