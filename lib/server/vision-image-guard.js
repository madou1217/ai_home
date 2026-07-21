'use strict';

// Gateway guard for the "text-only model got an image" failure.
//
// When a request targets a model that cannot see images (e.g. glm / deepseek via
// opencode) but its messages carry image parts, the upstream rejects the WHOLE
// request with HTTP 400 "does not support image inputs" — before the model ever
// gets a turn. That means the in-band aih-collab skill can never fire: there is
// no turn in which to borrow vision.
//
// This guard runs on the gateway just before dispatch. For non-vision targets it
// strips each image out of the payload, stashes it in the blob store, and leaves
// a text placeholder pointing the model at the blob handle so it can borrow
// vision via a subagent. The request then succeeds and the model can act on it.
//
// Vision-capable targets are a no-op (single cached modality lookup).

const { modelSupportsVision } = require('./model-modality-index');
const { putImageBlob } = require('./image-blob-store');

// Parse a data: URI ("data:image/png;base64,....") into { mime, bytes }.
function parseDataUri(url) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(url || ''));
  if (!match) return null;
  const mime = match[1] || 'image/png';
  const isBase64 = Boolean(match[2]);
  try {
    const bytes = isBase64
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    return bytes.length > 0 ? { mime, bytes } : null;
  } catch (_error) {
    return null;
  }
}

// Turn one content part into a borrow descriptor, or null if it is not an image.
// `handle` is either a gateway blob path (`/v1/blobs/<id>`) or an absolute http
// URL we could not inline; null means the bytes were unrecoverable.
function describeImagePart(part) {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'image_url' && part.image_url) {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
    const parsed = parseDataUri(url);
    if (parsed) return { mime: parsed.mime, handle: `/v1/blobs/${putImageBlob(parsed.bytes, parsed.mime)}` };
    if (/^https?:/i.test(String(url || ''))) return { mime: 'image', handle: String(url) };
    return { mime: 'image', handle: null };
  }

  if (part.type === 'image' && part.source && typeof part.source === 'object') {
    const src = part.source;
    if (src.type === 'base64' && src.data) {
      const bytes = Buffer.from(String(src.data), 'base64');
      const mime = src.media_type || 'image/png';
      if (bytes.length > 0) return { mime, handle: `/v1/blobs/${putImageBlob(bytes, mime)}` };
    }
    if (src.type === 'url' && src.url) return { mime: 'image', handle: String(src.url) };
    return { mime: 'image', handle: null };
  }

  return null;
}

function placeholderText(handle, mime) {
  // Blob paths are given relative to the gateway so both local and remote agents
  // resolve them against their own $AIH_GATEWAY_BASE_URL; absolute http handles
  // are passed through as-is.
  const location = handle
    ? (/^https?:/i.test(handle) ? handle : `$AIH_GATEWAY_BASE_URL${handle}`)
    : '(the image bytes could not be recovered)';
  return (
    `[aih: an image (${mime}) was attached here, but the current model cannot see images. `
    + `It is available at ${location}. To use it, spawn a vision-capable subagent — pin it to a `
    + `vision model (e.g. the Task tool's model override, or CLAUDE_CODE_SUBAGENT_MODEL) — and have `
    + `it fetch that URL and describe the image; treat the description as ground truth. Reuse an `
    + `existing description for the same URL instead of fetching again. See the aih-collab skill.]`
  );
}

// Mutates requestJson.messages in place (the same object every dispatch path
// rebuilds its upstream body from) and returns a small summary for logging.
function guardNonVisionImagePayload(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return { changed: false, count: 0 };
  const model = String(requestJson.model || '').trim();
  if (!model || modelSupportsVision(model)) return { changed: false, count: 0, model };
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : null;
  if (!messages) return { changed: false, count: 0, model };

  let count = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    let messageChanged = false;
    const nextContent = [];
    for (const part of message.content) {
      const image = describeImagePart(part);
      if (!image) {
        nextContent.push(part);
        continue;
      }
      count += 1;
      messageChanged = true;
      nextContent.push({ type: 'text', text: placeholderText(image.handle, image.mime) });
    }
    if (messageChanged) message.content = nextContent;
  }

  return { changed: count > 0, count, model };
}

module.exports = { guardNonVisionImagePayload, __private: { parseDataUri, describeImagePart } };
