'use strict';

const { remoteError } = require('../errors');
const { openSftpChannel } = require('../../runtime/ssh2-sftp-channel');

const sessions = new WeakMap();
const DEFAULT_TIMEOUT_MS = 15000;

function timeoutOf(options) {
  const value = Number(options && options.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

// Use a dedicated settlement guard: cancellation is decided before closing the
// channel, whose synchronous callbacks must not replace the timeout reason.
function boundedRequest(start, options = {}, onCancel = () => {}) {
  const { signal } = options;
  const timers = options.timers || { setTimeout, clearTimeout };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let dispose = () => {};
    const finish = (error, value) => {
      if (settled) return false;
      settled = true;
      if (timer) timers.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      dispose();
      if (error) reject(error); else resolve(value);
      return true;
    };
    const cancel = (error) => {
      if (finish(error)) onCancel();
    };
    const abort = () => cancel(remoteError('aborted', 'SFTP 操作已取消'));
    if (signal?.aborted) { finish(remoteError('aborted', 'SFTP 操作已取消')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = timers.setTimeout(() => cancel(remoteError('operation_timeout', 'SFTP 操作超时')), timeoutOf(options));
    try {
      dispose = start((error, value) => finish(error, value)) || (() => {});
      if (settled) dispose();
    } catch (error) {
      finish(error);
    }
  });
}

function closeStream(stream) {
  try { stream.destroy(); } catch (_error) { /* Already closed. */ }
}

async function openSftpSession(raw, options = {}) {
  if (options.signal?.aborted) throw remoteError('aborted', 'SFTP 操作已取消');
  let entry = sessions.get(raw);
  if (!entry) {
    entry = { pending: null, stream: null, closed: false, awaitingChannel: true, cancelOpen: null };
    sessions.set(raw, entry);
    const invalidate = () => {
      if (entry.closed) return;
      entry.closed = true;
      // Without subsystem acknowledgement there is no public channel handle.
      // Retain one closed tombstone to prevent unbounded pending opens.
      if (!entry.awaitingChannel && sessions.get(raw) === entry) sessions.delete(raw);
      if (entry.cancelOpen) entry.cancelOpen();
      else if (entry.stream) closeStream(entry.stream);
    };
    entry.pending = boundedRequest((done) => {
      const lost = () => done(remoteError('connection_lost', 'SSH 连接已关闭'));
      raw.once('close', lost);
      entry.cancelOpen = openSftpChannel(raw, {
        onChannelSettled() {
          entry.awaitingChannel = false;
          if (entry.closed && sessions.get(raw) === entry) sessions.delete(raw);
        },
        onChannel(stream) {
          entry.stream = stream;
          stream.once('close', invalidate);
          stream.once('end', invalidate);
          stream.on('error', invalidate);
          if (entry.closed) closeStream(stream);
        }
      }, (error, stream) => {
        if (entry.closed) { if (stream) closeStream(stream); return; }
        if (error) { done(error); return; }
        done(null, stream);
      });
      return () => raw.off('close', lost);
    }, options, invalidate).catch((error) => { invalidate(); throw error; });
    entry.invalidate = invalidate;
  }
  // A follower's timeout does not cancel somebody else's shared acquisition.
  const stream = await boundedRequest((done) => {
    entry.pending.then((value) => done(null, value), (error) => done(error));
  }, options);
  if (entry.closed) throw remoteError('connection_lost', 'SFTP 会话已关闭');
  return {
    stream,
    closed: () => entry.closed,
    call(method, args, callOptions = options) {
      if (entry.closed) return Promise.reject(remoteError('connection_lost', 'SFTP 会话已关闭'));
      return boundedRequest((done) => {
        const lost = () => done(remoteError('connection_lost', 'SFTP 通道已关闭'));
        const failed = (error) => done(error);
        stream.once('close', lost);
        stream.once('end', lost);
        stream.once('error', failed);
        try { stream[method](...args, (error, value) => {
          if (error && typeof error.code !== 'number') {
            done(remoteError('connection_lost', 'SFTP 响应未确认，连接已失效'));
            entry.invalidate();
          } else done(error, value);
        }); }
        catch (error) { done(error); }
        return () => { stream.off('close', lost); stream.off('end', lost); stream.off('error', failed); };
      }, callOptions, entry.invalidate);
    }
  };
}

module.exports = { openSftpSession };
