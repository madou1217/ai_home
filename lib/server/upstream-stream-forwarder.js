'use strict';

const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const STREAM_USAGE_TAIL_MAX_BYTES = 64 * 1024;

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(chunk || []);
}

function createBoundedTailCapture(capacity = STREAM_USAGE_TAIL_MAX_BYTES) {
  const normalizedCapacity = Math.max(1, Math.floor(Number(capacity) || STREAM_USAGE_TAIL_MAX_BYTES));
  const storage = Buffer.allocUnsafe(normalizedCapacity);
  let size = 0;
  let writeOffset = 0;

  return {
    append(chunk) {
      const input = toBuffer(chunk);
      if (input.length === 0) return;
      if (input.length >= normalizedCapacity) {
        input.copy(storage, 0, input.length - normalizedCapacity);
        size = normalizedCapacity;
        writeOffset = 0;
        return;
      }

      const firstLength = Math.min(input.length, normalizedCapacity - writeOffset);
      input.copy(storage, writeOffset, 0, firstLength);
      if (firstLength < input.length) {
        input.copy(storage, 0, firstLength);
      }
      writeOffset = (writeOffset + input.length) % normalizedCapacity;
      size = Math.min(normalizedCapacity, size + input.length);
    },
    toBuffer() {
      if (size === 0) return Buffer.alloc(0);
      if (size < normalizedCapacity) return Buffer.from(storage.subarray(0, size));
      if (writeOffset === 0) return Buffer.from(storage);
      return Buffer.concat([
        storage.subarray(writeOffset),
        storage.subarray(0, writeOffset)
      ], normalizedCapacity);
    },
    get capacity() {
      return normalizedCapacity;
    },
    get size() {
      return size;
    }
  };
}

function removeListener(target, event, listener) {
  if (target && typeof target.off === 'function') {
    target.off(event, listener);
    return;
  }
  if (target && typeof target.removeListener === 'function') {
    target.removeListener(event, listener);
  }
}

function bindDownstreamDisconnect(res, cancel) {
  if (!res || typeof res.once !== 'function' || typeof cancel !== 'function') {
    return () => {};
  }
  const onDisconnect = () => cancel();
  res.once('close', onDisconnect);
  res.once('error', onDisconnect);
  return () => {
    removeListener(res, 'close', onDisconnect);
    removeListener(res, 'error', onDisconnect);
  };
}

function createDownstreamAbortContext(req, res) {
  const controller = new AbortController();
  let downstreamDisconnected = false;
  const listeners = [];
  const abort = () => {
    downstreamDisconnected = true;
    try { controller.abort('downstream_disconnected'); } catch (_error) { controller.abort(); }
  };
  const bind = (target, event) => {
    if (!target || typeof target.once !== 'function') return;
    target.once(event, abort);
    listeners.push({ target, event });
  };
  bind(req, 'aborted');
  bind(res, 'close');
  bind(res, 'error');
  if ((req && req.aborted) || (res && (res.destroyed || res.writableEnded))) abort();
  return {
    signal: controller.signal,
    isDisconnected: () => downstreamDisconnected,
    dispose() {
      listeners.splice(0).forEach(({ target, event }) => removeListener(target, event, abort));
    }
  };
}

function createBodySource(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    let cancelled = false;
    return {
      next: () => reader.read(),
      async cancel(reason) {
        if (cancelled) return;
        cancelled = true;
        if (typeof reader.cancel === 'function') await reader.cancel(reason);
      },
      release() {
        if (typeof reader.releaseLock !== 'function') return;
        try { reader.releaseLock(); } catch (_error) {}
      }
    };
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    let cancelled = false;
    return {
      next: () => iterator.next(),
      async cancel(reason) {
        if (cancelled) return;
        cancelled = true;
        if (typeof body.cancel === 'function') {
          await body.cancel(reason);
          return;
        }
        if (typeof iterator.return === 'function') await iterator.return();
      },
      release() {}
    };
  }

  return null;
}

async function readBodyPrefix(source) {
  const chunks = [];
  let firstByte = -1;
  for (;;) {
    const entry = await source.next();
    if (entry.done) return { chunks, gzip: false, done: true };
    const chunk = toBuffer(entry.value);
    if (chunk.length === 0) continue;
    chunks.push(chunk);
    if (firstByte < 0) {
      firstByte = chunk[0];
      if (firstByte !== 0x1f) return { chunks, gzip: false, done: false };
      if (chunk.length > 1) {
        return { chunks, gzip: chunk[1] === 0x8b, done: false };
      }
      continue;
    }
    return { chunks, gzip: chunk[0] === 0x8b, done: false };
  }
}

async function* iterateBody(source, prefix) {
  let completed = false;
  try {
    for (const chunk of prefix.chunks) yield chunk;
    if (!prefix.done) {
      for (;;) {
        const entry = await source.next();
        if (entry.done) break;
        yield toBuffer(entry.value);
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      try { await source.cancel('stream_interrupted'); } catch (_error) {}
    }
  }
}

function isResponseClosed(res) {
  return Boolean(res && (res.writableEnded || res.destroyed));
}

function waitForDrainOrClose(res) {
  if (isResponseClosed(res)) return Promise.resolve(false);
  if (!res || typeof res.once !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      removeListener(res, 'drain', onDrain);
      removeListener(res, 'close', onClose);
      removeListener(res, 'error', onError);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (isResponseClosed(res)) finish(false);
  });
}

async function writeChunkToResponse(res, chunk, onChunk, isDisconnected) {
  if (isResponseClosed(res)) return false;
  const buffer = toBuffer(chunk);
  if (buffer.length === 0) return true;
  let accepted;
  try {
    accepted = res.write(buffer);
  } catch (_error) {
    return false;
  }
  if (typeof onChunk === 'function') onChunk(buffer);
  if (typeof isDisconnected === 'function' && isDisconnected()) return false;
  if (accepted !== false) return true;
  return waitForDrainOrClose(res);
}

async function forwardIterable(iterable, res, onChunk, isDisconnected) {
  for await (const chunk of iterable) {
    if (!await writeChunkToResponse(res, chunk, onChunk, isDisconnected)) return false;
  }
  return true;
}

async function pipeReadableBodyToResponse(body, res, options = {}) {
  const source = createBodySource(body);
  if (!source) return { downstreamDisconnected: false };
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
  let downstreamDisconnected = false;
  let inputStream = null;
  let decodedStream = null;
  let forwardInputError = null;
  const cancel = () => {
    downstreamDisconnected = true;
    if (decodedStream) decodedStream.destroy();
    if (inputStream) inputStream.destroy();
    Promise.resolve(source.cancel('downstream_disconnected')).catch(() => {});
  };
  const unbind = bindDownstreamDisconnect(res, cancel);
  if (isResponseClosed(res)) cancel();

  try {
    const prefix = await readBodyPrefix(source);
    if (downstreamDisconnected) return { downstreamDisconnected: true };
    const input = iterateBody(source, prefix);
    let completed;
    if (prefix.gzip) {
      inputStream = Readable.from(input);
      decodedStream = inputStream.pipe(zlib.createGunzip());
      forwardInputError = (error) => decodedStream.destroy(error);
      inputStream.once('error', forwardInputError);
      completed = await forwardIterable(decodedStream, res, onChunk, () => downstreamDisconnected);
    } else {
      completed = await forwardIterable(input, res, onChunk, () => downstreamDisconnected);
    }
    if (!completed) cancel();
  } catch (error) {
    if (!downstreamDisconnected) throw error;
  } finally {
    if (forwardInputError) removeListener(inputStream, 'error', forwardInputError);
    if (decodedStream && !decodedStream.destroyed) decodedStream.destroy();
    if (inputStream && !inputStream.destroyed) inputStream.destroy();
    unbind();
    source.release();
  }
  return { downstreamDisconnected };
}

module.exports = {
  STREAM_USAGE_TAIL_MAX_BYTES,
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
};
