'use strict';

function decodeSseChunk(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk || '');
}

function normalizeSseBuffer(buffer) {
  return String(buffer || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseSseJsonFrame(frame) {
  const dataLines = String(frame || '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  if (!dataLines.length) return null;
  return JSON.parse(dataLines.join('\n'));
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function createAbortError() {
  const error = new Error('sse_stream_aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

async function consumeSseJsonStream(response, onJson, options = {}) {
  const body = response && response.body;
  const signal = options.signal;
  let buffer = '';

  async function pushText(text) {
    buffer = normalizeSseBuffer(buffer + text);
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = parseSseJsonFrame(frame);
      if (payload != null) await onJson(payload);
      boundary = buffer.indexOf('\n\n');
    }
  }

  function assertNotAborted() {
    if (signal && signal.aborted) throw createAbortError();
  }

  assertNotAborted();
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        assertNotAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        await pushText(decodeSseChunk(chunk.value));
      }
    } finally {
      if (signal && signal.aborted && typeof reader.cancel === 'function') {
        try {
          await reader.cancel();
        } catch (_error) {}
      }
    }
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      assertNotAborted();
      await pushText(decodeSseChunk(chunk));
    }
  } else if (response && typeof response.text === 'function') {
    await pushText(await response.text());
  }
  if (buffer.trim()) {
    const payload = parseSseJsonFrame(buffer);
    if (payload != null) await onJson(payload);
  }
}

module.exports = {
  consumeSseJsonStream,
  isAbortError
};
