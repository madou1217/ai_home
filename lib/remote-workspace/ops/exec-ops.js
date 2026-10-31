'use strict';

// 在远端执行命令（一个 exec 通道 = 一次命令），拿到 stdout/stderr/退出码。
// 输出按字节上限截断（不把一个失控的命令输出全读进内存）；stdin 可选（用于 base64 写文件）。

const { withDeadline } = require('../channel/deadline');
const { remoteError, fromTransportError } = require('../errors');

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

/**
 * @param {object} raw ssh2 Client
 * @param {string} command 远端命令行（由 dialect 构造，调用方保证已转义）
 * @param {{timeoutMs, label, timers, stdin?: Buffer|string, maxOutputBytes?: number, signal?: AbortSignal}} options
 * @returns {Promise<{code: number|null, signal: string|null, stdout: Buffer, stderr: Buffer, truncated: boolean}>}
 */
function execOnce(raw, command, options) {
  const limit = options.maxOutputBytes || DEFAULT_OUTPUT_LIMIT;
  return withDeadline(({ resolve, reject }) => {
    let stream = null;
    raw.exec(command, (error, channel) => {
      if (error) return reject(remoteError('channel_open_failed', '无法在远端打开执行通道', { cause: String(error.message || error) }));
      stream = channel;
      const stdout = [];
      const stderr = [];
      let size = 0;
      let truncated = false;
      let code = null;
      let signal = null;
      const take = (bucket) => (chunk) => {
        if (size >= limit) { truncated = true; return; }
        const room = limit - size;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (piece.length < chunk.length) truncated = true;
        bucket.push(piece);
        size += piece.length;
      };
      channel.on('data', take(stdout));
      channel.stderr.on('data', take(stderr));
      channel.on('exit', (exitCode, exitSignal) => { code = exitCode; signal = exitSignal || null; });
      channel.on('error', (streamError) => reject(fromTransportError(streamError)));
      channel.once('close', () => resolve({
        code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated
      }));
      if (options.stdin !== undefined) channel.end(options.stdin);
    });
    // 超时 / 取消：关掉通道（远端命令随会话结束收到 SIGHUP）。
    return () => { if (stream) { try { stream.close(); } catch (_error) { /* gone */ } } };
  }, options);
}

module.exports = { execOnce };
