'use strict';

// In-memory, content-addressed store for images stripped out of requests that
// are bound for a text-only (non-vision) upstream model. A vision-capable
// subagent fetches them back through `GET /v1/blobs/<id>`.
//
// The id is a sha256 of the bytes, so the same image re-sent across
// conversation turns maps to a stable handle — the borrow can be described once
// and reused, instead of paying for a fresh describe every turn.

const crypto = require('crypto');

const MAX_ENTRIES = 256;
const store = new Map(); // id -> { bytes: Buffer, mime: string }

function putImageBlob(bytes, mime) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
  if (store.has(id)) {
    // Refresh LRU recency without duplicating the payload.
    const existing = store.get(id);
    store.delete(id);
    store.set(id, existing);
    return id;
  }
  store.set(id, { bytes: buf, mime: String(mime || 'application/octet-stream') });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  return id;
}

function getImageBlob(id) {
  return store.get(String(id || '').trim()) || null;
}

function resetImageBlobStore() {
  store.clear();
}

module.exports = { putImageBlob, getImageBlob, resetImageBlobStore, __MAX_ENTRIES: MAX_ENTRIES };
