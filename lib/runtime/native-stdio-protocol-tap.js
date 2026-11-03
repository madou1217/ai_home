'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Transform } = require('node:stream');
const { bridgeError } = require('./native-session-bridge-files');

// Keep the Desktop's protocol and authentication callbacks intact. Consume
// only responses to this adapter's private request IDs; never log frames.
function createNativeStdioProtocolTap({ input, output, timeoutMs = 15000 }) {
  const events = new EventEmitter();
  const pending = new Map();
  const prefix = `aih-desktop-${crypto.randomUUID()}-`;
  let counter = 0, inputBuffer = Buffer.alloc(0), outputBuffer = Buffer.alloc(0);
  let disposed = false, atLineBoundary = true, writingRequests = false;
  const observeInput = chunk => {
    if (chunk.length) atLineBoundary = chunk.at(-1) === 10;
    inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
    let end;
    while ((end = inputBuffer.indexOf(10)) >= 0) {
      const line = inputBuffer.subarray(0, end);
      inputBuffer = inputBuffer.subarray(end + 1);
      try { events.emit('input', JSON.parse(line)); } catch (_) {}
    }
    if (inputBuffer.length > 16 * 1024 * 1024) inputBuffer = Buffer.alloc(0);
  };
  const protocolInput = new Transform({
    transform(chunk, _encoding, callback) {
      observeInput(chunk);
      callback(null, chunk);
      flushRequests();
    }
  });
  input.pipe(protocolInput);
  const protocolOutput = new Transform({
    transform(chunk, _encoding, callback) {
      outputBuffer = Buffer.concat([outputBuffer, chunk]);
      let end;
      while ((end = outputBuffer.indexOf(10)) >= 0) {
        const frame = outputBuffer.subarray(0, end + 1);
        outputBuffer = outputBuffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(frame); } catch (_) {}
        if (typeof message?.id === 'string' && message.id.startsWith(prefix) && !message.method) {
          const request = pending.get(message.id);
          if (request) {
            pending.delete(message.id);
            clearTimeout(request.timer);
            if (message.error) request.reject(bridgeError('zcode_desktop_protocol_failed', 'ZCode Desktop 拒绝了本次会话操作。'));
            else request.resolve(message.result);
          }
        } else this.push(frame);
        if (message) events.emit('message', message);
      }
      callback();
    },
    flush(callback) { if (outputBuffer.length) this.push(outputBuffer); callback(); }
  });
  protocolOutput.pipe(output, { end: false });
  protocolInput.isTTY = false;
  protocolOutput.isTTY = false;

  function flushRequests() {
    if (disposed || !atLineBoundary || writingRequests) return;
    writingRequests = true;
    try {
      for (const [id, request] of pending) {
        if (request.sent) continue;
        request.sent = true;
        protocolInput.write(request.frame, error => {
          if (!error || pending.get(id) !== request) return;
          pending.delete(id);
          clearTimeout(request.timer);
          request.reject(Object.assign(bridgeError('zcode_desktop_protocol_unavailable'), { dispatched: true }));
        });
      }
    } finally { writingRequests = false; }
  }

  return {
    input: protocolInput, output: protocolOutput,
    on: (...args) => events.on(...args),
    off: (...args) => events.off(...args),
    request(method, params) {
      if (disposed) return Promise.reject(Object.assign(bridgeError('zcode_desktop_runtime_restarted'), { dispatched: false }));
      const id = `${prefix}${++counter}`;
      return new Promise((resolve, reject) => {
        const request = { resolve, reject, sent: false, frame: `${JSON.stringify({ id, method, params })}\n` };
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(bridgeError('zcode_desktop_protocol_timeout', '等待 ZCode Desktop 协议响应超时；请求不会重放。'),
            { dispatched: request.sent }));
        }, timeoutMs);
        request.timer = timer;
        pending.set(id, request);
        flushRequests();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      input.unpipe(protocolInput);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(Object.assign(bridgeError('zcode_desktop_runtime_restarted'), { dispatched: request.sent }));
      }
      pending.clear();
      protocolOutput.end();
    }
  };
}

module.exports = { createNativeStdioProtocolTap };
