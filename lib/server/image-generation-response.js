'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');

const DEFAULT_MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_IMAGE_RESPONSE_READ_TIMEOUT_MS = 120000;

function readHeader(response, name) {
  if (response && response.headers && typeof response.headers.get === 'function') {
    return response.headers.get(name);
  }
  const headers = response && response.headers && typeof response.headers === 'object'
    ? response.headers
    : {};
  return headers[String(name || '').toLowerCase()] || headers[name] || null;
}

function resolveMaxResponseBytes(options = {}) {
  const configured = Number(options.imageGenMaxResponseBytes);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_IMAGE_RESPONSE_BYTES;
}

function resolveResponseReadTimeoutMs(options = {}) {
  const explicit = Number(options.imageGenResponseReadTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const upstreamTimeoutMs = Number(options.upstreamTimeoutMs);
  return Math.max(
    Number.isFinite(upstreamTimeoutMs) && upstreamTimeoutMs > 0 ? Math.floor(upstreamTimeoutMs) : 0,
    DEFAULT_IMAGE_RESPONSE_READ_TIMEOUT_MS
  );
}

function responseTooLarge(maxBytes) {
  return new ImageGenerationError(
    502,
    'upstream_response_too_large',
    `image upstream response exceeds the configured ${maxBytes} byte limit`
  );
}

function responseReadTimedOut(timeoutMs) {
  return new ImageGenerationError(
    502,
    'upstream_failed',
    `image upstream response read timed out after ${timeoutMs} ms`
  );
}

function responseReadFailed(error) {
  return new ImageGenerationError(
    502,
    'upstream_failed',
    `image upstream response read failed: ${String(error && error.message || error)}`
  );
}

async function disposeResponseBody(body, reason) {
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') await body.cancel(reason);
    else if (typeof body.destroy === 'function') body.destroy(reason);
  } catch (_error) {}
}

async function readBoundedChunks(source, maxBytes, timeoutMs) {
  const chunks = [];
  let totalBytes = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(responseReadTimedOut(timeoutMs)), timeoutMs);
  });
  try {
    for (;;) {
      const entry = await Promise.race([source.next(), deadline]);
      if (entry.done) return Buffer.concat(chunks, totalBytes).toString('utf8');
      const chunk = Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value || []);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw responseTooLarge(maxBytes);
      chunks.push(chunk);
    }
  } catch (error) {
    try { await source.cancel(error); } catch (_cancelError) {}
    throw error;
  } finally {
    clearTimeout(timer);
    source.release();
  }
}

async function readFallbackWithDeadline(task, body, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(responseReadTimedOut(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(task), deadline]);
  } catch (error) {
    await disposeResponseBody(body, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readImageGenerationResponseText(response, options = {}) {
  const maxBytes = resolveMaxResponseBytes(options);
  const timeoutMs = resolveResponseReadTimeoutMs(options);
  try {
    const contentLength = Number(readHeader(response, 'content-length')) || 0;
    if (contentLength > maxBytes) {
      const error = responseTooLarge(maxBytes);
      await disposeResponseBody(response && response.body, error);
      throw error;
    }

    const body = response && response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const text = await readBoundedChunks({
        next: () => reader.read(),
        cancel: (reason) => typeof reader.cancel === 'function' ? reader.cancel(reason) : undefined,
        release: () => {
          try { reader.releaseLock && reader.releaseLock(); } catch (_error) {}
        }
      }, maxBytes, timeoutMs);
      return text;
    }
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      const iterator = body[Symbol.asyncIterator]();
      const text = await readBoundedChunks({
        next: () => iterator.next(),
        cancel: (reason) => typeof iterator.return === 'function'
          ? iterator.return(reason)
          : disposeResponseBody(body, reason),
        release: () => {}
      }, maxBytes, timeoutMs);
      return text;
    }

    if (response && typeof response.arrayBuffer === 'function') {
      const bytes = Buffer.from(await readFallbackWithDeadline(
        () => response.arrayBuffer(),
        body,
        timeoutMs
      ));
      if (bytes.length > maxBytes) throw responseTooLarge(maxBytes);
      return bytes.toString('utf8');
    }
    if (response && typeof response.text === 'function') {
      const text = String(await readFallbackWithDeadline(
        () => response.text(),
        body,
        timeoutMs
      ));
      if (Buffer.byteLength(text) > maxBytes) throw responseTooLarge(maxBytes);
      return text;
    }
    return '';
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    throw responseReadFailed(error);
  }
}

module.exports = {
  readImageGenerationResponseText,
  __private: {
    DEFAULT_IMAGE_RESPONSE_READ_TIMEOUT_MS,
    DEFAULT_MAX_IMAGE_RESPONSE_BYTES,
    disposeResponseBody,
    readBoundedChunks,
    readFallbackWithDeadline,
    readHeader,
    resolveMaxResponseBytes,
    resolveResponseReadTimeoutMs,
    responseReadFailed,
    responseReadTimedOut,
    responseTooLarge
  }
};
