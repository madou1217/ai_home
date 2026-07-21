'use strict';

const { validateImageBuffer } = require('./image-data');

const OSC52_PREFIX = '\x1b]52;';
const OSC5522_PREFIX = '\x1b]5522;';
const STRING_TERMINATOR = '\x1b\\';
const BEL_TERMINATOR = '\x07';
const TMUX_PASSTHROUGH_PREFIX = '\x1bPtmux;';
const PASTE_EVENTS_5522_SUPPORT_QUERY = '\x1b[?5522$p';
const PASTE_EVENTS_5522_SUPPORT_RESPONSE_PREFIX = '\x1b[?5522;';
const PASTE_EVENTS_5522_ENABLE = '\x1b[?5522h';
const PASTE_EVENTS_5522_DISABLE = '\x1b[?5522l';
const OSC5522_TARGETS_MIME = '.';
const OSC5522_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff'
];
const OSC5522_TEXT_IMAGE_MIME_TYPES = [
  'text/html'
];
const OSC5522_READ_MIME_TYPES = [
  ...OSC5522_IMAGE_MIME_TYPES,
  ...OSC5522_TEXT_IMAGE_MIME_TYPES
];
const DEFAULT_MAX_BUFFERED_TEXT = 24 * 1024 * 1024;
const DEFAULT_RESPONSE_ID = '__default__';

function createTerminalClipboardError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parsePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function longestPrefixSuffix(text, prefix) {
  const max = Math.min(text.length, prefix.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (prefix.startsWith(text.slice(text.length - size))) return size;
  }
  return 0;
}

function normalizeBase64(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text || text === '?' || !/^[A-Za-z0-9+/=]+$/.test(text)) return '';
  return text;
}

function decodeBase64Payload(value, maxBytes) {
  const base64 = normalizeBase64(value);
  if (!base64) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > maxBytes) {
    throw createTerminalClipboardError('ssh_clip_terminal_clipboard_too_large');
  }
  return buffer.length > 0 ? buffer : null;
}

function imageFromBuffer(buffer, maxBytes, mimeType = '') {
  try {
    const info = validateImageBuffer(buffer, { maxBytes, mimeType });
    return {
      buffer,
      mimeType: info.mimeType,
      sha256: info.sha256,
      byteLength: info.byteLength
    };
  } catch (error) {
    if (error && error.code === 'ssh_clip_image_too_large') throw error;
    return null;
  }
}

function imageFromDataUrlText(text, maxBytes) {
  const match = String(text || '').match(/data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff?));base64,([A-Za-z0-9+/=]+)/i);
  if (!match) return null;
  const buffer = decodeBase64Payload(match[2], maxBytes);
  return buffer ? imageFromBuffer(buffer, maxBytes) : null;
}

function decodeTerminalClipboardImagePayload(payload, options = {}) {
  const maxBytes = parsePositiveInteger(options.maxBytes, 16 * 1024 * 1024);
  const decoded = decodeBase64Payload(payload, maxBytes);
  if (!decoded) return null;

  const direct = imageFromBuffer(decoded, maxBytes);
  if (direct) return direct;

  return imageFromDataUrlText(decoded.toString('utf8'), maxBytes);
}

function sanitizeOsc5522Id(value) {
  return String(value || '').replace(/[^A-Za-z0-9._+-]+/g, '').slice(0, 80);
}

function encodeUtf8Base64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function wrapTerminalEscapeForTmuxPassthrough(sequence) {
  const text = String(sequence || '');
  if (!text) return '';
  return `${TMUX_PASSTHROUGH_PREFIX}${text.replace(/\x1b/g, '\x1b\x1b')}${STRING_TERMINATOR}`;
}

function maybeWrapForTmux(sequence, options = {}) {
  return options.tmuxPassthrough ? wrapTerminalEscapeForTmuxPassthrough(sequence) : sequence;
}

function buildTerminalClipboardPasteEventsModeSequence(options = {}) {
  const enabled = options.enabled !== false;
  const sequence = enabled ? PASTE_EVENTS_5522_ENABLE : PASTE_EVENTS_5522_DISABLE;
  return maybeWrapForTmux(sequence, options);
}

function buildTerminalClipboardPasteEventsSupportQuery(options = {}) {
  return maybeWrapForTmux(PASTE_EVENTS_5522_SUPPORT_QUERY, options);
}

function normalizeTerminalMimeType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === OSC5522_TARGETS_MIME) return OSC5522_TARGETS_MIME;
  if (text === 'public.png' || text === 'png') return 'image/png';
  if (text === 'public.jpeg' || text === 'public.jpg' || text === 'jpeg' || text === 'jpg' || text === 'image/jpg') return 'image/jpeg';
  if (text === 'public.webp' || text === 'webp') return 'image/webp';
  if (text === 'public.gif' || text === 'gif') return 'image/gif';
  if (text === 'public.bmp' || text === 'bmp') return 'image/bmp';
  if (text === 'public.tiff' || text === 'public.tif' || text === 'tiff' || text === 'tif' || text === 'image/tif') return 'image/tiff';
  if (text === 'public.html' || text === 'html') return 'text/html';
  if (text === 'utf8' || text === 'plain' || text === 'public.utf8-plain-text') return 'text/plain';
  return text;
}

function normalizeMimeList(values) {
  const seen = new Set();
  return (Array.isArray(values) && values.length > 0 ? values : OSC5522_READ_MIME_TYPES)
    .map((value) => normalizeTerminalMimeType(value))
    .filter((value) => OSC5522_READ_MIME_TYPES.includes(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function normalizeReadMimeType(value) {
  const text = normalizeTerminalMimeType(value);
  if (text === OSC5522_TARGETS_MIME) return OSC5522_TARGETS_MIME;
  if (OSC5522_IMAGE_MIME_TYPES.includes(text)) return text;
  if (OSC5522_TEXT_IMAGE_MIME_TYPES.includes(text)) return text;
  if (text === 'text/plain') return text;
  return '';
}

function normalizeLocation(value) {
  return String(value || '').trim().toLowerCase() === 'primary' ? 'primary' : '';
}

function normalizeOsc52Selection(value) {
  const text = String(value || 'c').replace(/[^A-Za-z0-9]/g, '');
  return text || 'c';
}

function normalizePasswordToken(value) {
  return normalizeBase64(value);
}

function buildOsc52ClipboardReadQuery(options = {}) {
  const selection = normalizeOsc52Selection(options.selection);
  return maybeWrapForTmux(`${OSC52_PREFIX}${selection};?${BEL_TERMINATOR}`, options);
}

function buildOsc5522ClipboardReadMimeQuery(options = {}) {
  const mimeType = normalizeReadMimeType(options.mimeType);
  if (!mimeType) return '';
  const metadata = ['type=read'];
  const id = sanitizeOsc5522Id(options.id);
  if (id) metadata.push(`id=${id}`);
  const loc = normalizeLocation(options.loc);
  if (loc) metadata.push(`loc=${loc}`);
  const encodedMimeType = encodeUtf8Base64(mimeType);
  metadata.push(`mime=${encodedMimeType}`);
  const password = normalizePasswordToken(options.pw);
  if (password) {
    const passwordKey = String(options.passwordKey || '').trim().toLowerCase() === 'password' ? 'password' : 'pw';
    metadata.push(`${passwordKey}=${password}`);
  }
  const name = String(options.name || '').trim();
  if (name) metadata.push(`name=${encodeUtf8Base64(name)}`);
  return maybeWrapForTmux(`${OSC5522_PREFIX}${metadata.join(':')};${encodedMimeType}${STRING_TERMINATOR}`, options);
}

function buildOsc5522ClipboardListMimeTypesQuery(options = {}) {
  const metadata = ['type=read'];
  const id = sanitizeOsc5522Id(options.id);
  if (id) metadata.push(`id=${id}`);
  const loc = normalizeLocation(options.loc);
  if (loc) metadata.push(`loc=${loc}`);
  const query = `${OSC5522_PREFIX}${metadata.join(':')};${encodeUtf8Base64(OSC5522_TARGETS_MIME)}${STRING_TERMINATOR}`;
  return maybeWrapForTmux(query, options);
}

function buildOsc5522ClipboardReadImageQuery(options = {}) {
  if (options.mimeType) return buildOsc5522ClipboardReadMimeQuery(options);
  const mimeTypes = normalizeMimeList(options.mimeTypes);
  const metadata = ['type=read'];
  const id = sanitizeOsc5522Id(options.id);
  if (id) metadata.push(`id=${id}`);
  const query = `${OSC5522_PREFIX}${metadata.join(':')};${encodeUtf8Base64(mimeTypes.join(' '))}${STRING_TERMINATOR}`;
  return maybeWrapForTmux(query, options);
}

function parseOsc52Body(body) {
  const text = String(body || '');
  const separator = text.indexOf(';');
  if (separator <= 0) return null;
  return {
    selection: text.slice(0, separator),
    payload: text.slice(separator + 1)
  };
}

function parseOsc5522Body(body) {
  const text = String(body || '');
  const separator = text.indexOf(';');
  const metadataText = separator >= 0 ? text.slice(0, separator) : text;
  const payload = separator >= 0 ? text.slice(separator + 1) : '';
  const metadata = {};
  metadataText.split(':').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key) return;
    metadata[key] = part.slice(eq + 1);
  });
  return { metadata, payload, hasPayload: separator >= 0 };
}

function decodeOsc5522Mime(value) {
  const base64 = normalizeBase64(value);
  if (!base64) return '';
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > 128) return '';
  return normalizeTerminalMimeType(buffer.toString('utf8'));
}

function errorForOsc5522Status(status) {
  const normalized = String(status || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return createTerminalClipboardError(`ssh_clip_terminal_clipboard_${normalized || 'failed'}`);
}

function longestProtocolPrefixSuffix(text) {
  return Math.max(
    longestPrefixSuffix(text, OSC52_PREFIX),
    longestPrefixSuffix(text, OSC5522_PREFIX),
    longestPrefixSuffix(text, PASTE_EVENTS_5522_SUPPORT_RESPONSE_PREFIX)
  );
}

function findNextProtocolStart(text) {
  const candidates = [
    { prefix: OSC5522_PREFIX, protocol: 'osc5522' },
    { prefix: OSC52_PREFIX, protocol: 'osc52' },
    { prefix: PASTE_EVENTS_5522_SUPPORT_RESPONSE_PREFIX, protocol: 'paste_events_support' }
  ];
  let best = null;
  candidates.forEach((candidate) => {
    const index = text.indexOf(candidate.prefix);
    if (index < 0) return;
    if (!best || index < best.index) {
      best = { ...candidate, index };
    }
  });
  return best;
}

function parsePasteEventsSupportResponse(text) {
  const match = String(text || '').match(/^\x1b\[\?5522;([0-9]+)\$y$/);
  if (!match) return null;
  const state = Number(match[1]);
  if (!Number.isInteger(state)) return null;
  return {
    mode: 5522,
    state,
    supported: state !== 0 && state !== 4,
    enabled: state === 1 || state === 3
  };
}

function createTerminalClipboardImageParser(options = {}) {
  const maxBytes = parsePositiveInteger(options.maxBytes, 16 * 1024 * 1024);
  const preferredMimeTypes = normalizeMimeList(options.mimeTypes);
  const maxBufferedText = Math.max(OSC5522_PREFIX.length + 128, parsePositiveInteger(options.maxBufferedText, DEFAULT_MAX_BUFFERED_TEXT));
  let buffer = '';
  const reads = new Map();

  function resetOversizedBuffer() {
    if (buffer.length <= maxBufferedText) return;
    const suffix = longestProtocolPrefixSuffix(buffer);
    buffer = suffix > 0 ? buffer.slice(buffer.length - suffix) : '';
  }

  function getReadState(id) {
    const key = sanitizeOsc5522Id(id) || DEFAULT_RESPONSE_ID;
    let state = reads.get(key);
    if (!state) {
      state = {
        chunksByMime: new Map(),
        availableMimeTypes: [],
        isPasteNotification: false,
        isMimeListQuery: false,
        loc: '',
        pw: '',
        passwordKey: 'pw',
        totalBytes: 0
      };
      reads.set(key, state);
    }
    return state;
  }

  function trackOsc5522PasteMetadata(state, metadata) {
    const loc = normalizeLocation(metadata.loc);
    if (loc) state.loc = loc;
    const passwordKey = metadata.password ? 'password' : 'pw';
    const pw = normalizePasswordToken(metadata.pw || metadata.password);
    if (pw) {
      state.pw = pw;
      state.passwordKey = passwordKey;
    }
  }

  function appendOsc5522Data(metadata, payload, hasPayload) {
    const mimeType = decodeOsc5522Mime(metadata.mime);
    if (!mimeType) return;
    if (!hasPayload) {
      const state = getReadState(metadata.id);
      trackOsc5522PasteMetadata(state, metadata);
      if (!state.availableMimeTypes.includes(mimeType)) state.availableMimeTypes.push(mimeType);
      state.isPasteNotification = true;
      return;
    }
    const chunk = decodeBase64Payload(payload, maxBytes);
    if (!chunk) return;
    const state = getReadState(metadata.id);
    trackOsc5522PasteMetadata(state, metadata);
    if (mimeType === OSC5522_TARGETS_MIME) {
      const available = chunk.toString('utf8')
        .split(/\s+/)
        .map((value) => normalizeTerminalMimeType(value))
        .filter(Boolean);
      available.forEach((value) => {
        if (!state.availableMimeTypes.includes(value)) state.availableMimeTypes.push(value);
      });
      state.isMimeListQuery = true;
      return;
    }
    if (state.totalBytes + chunk.length > maxBytes) {
      reads.delete(sanitizeOsc5522Id(metadata.id) || DEFAULT_RESPONSE_ID);
      throw createTerminalClipboardError('ssh_clip_terminal_clipboard_too_large');
    }
    if (!state.chunksByMime.has(mimeType)) state.chunksByMime.set(mimeType, []);
    state.chunksByMime.get(mimeType).push(chunk);
    state.totalBytes += chunk.length;
  }

  function imageFromOsc5522State(state) {
    if (!state || state.chunksByMime.size === 0) return null;

    const mimeTypes = [
      ...preferredMimeTypes,
      ...Array.from(state.chunksByMime.keys()).filter((mimeType) => !preferredMimeTypes.includes(mimeType))
    ];
    for (const mimeType of mimeTypes) {
      const chunks = state.chunksByMime.get(mimeType);
      if (!Array.isArray(chunks) || chunks.length === 0) continue;
      const image = imageFromBuffer(Buffer.concat(chunks), maxBytes, mimeType);
      if (image) return image;
    }

    for (const mimeType of OSC5522_TEXT_IMAGE_MIME_TYPES) {
      const chunks = state.chunksByMime.get(mimeType);
      if (!Array.isArray(chunks) || chunks.length === 0) continue;
      const image = imageFromDataUrlText(Buffer.concat(chunks).toString('utf8'), maxBytes);
      if (image) return image;
    }

    const textChunks = state.chunksByMime.get('text/plain');
    if (Array.isArray(textChunks) && textChunks.length > 0) {
      return imageFromDataUrlText(Buffer.concat(textChunks).toString('utf8'), maxBytes);
    }
    return null;
  }

  function textFromOsc5522State(state) {
    if (!state || !state.chunksByMime.has('text/plain')) return null;
    const chunks = state.chunksByMime.get('text/plain');
    if (!Array.isArray(chunks) || chunks.length === 0) return null;
    const buffer = Buffer.concat(chunks);
    return buffer.length > 0 ? { buffer, mimeType: 'text/plain' } : null;
  }

  function choosePasteRequestFromOsc5522State(state) {
    if (!state || !state.isPasteNotification) return null;
    const available = Array.isArray(state.availableMimeTypes) ? state.availableMimeTypes : [];
    const imageMimeType = preferredMimeTypes.find((mimeType) => available.includes(mimeType))
      || available.find((mimeType) => OSC5522_IMAGE_MIME_TYPES.includes(mimeType));
    const textImageMimeType = OSC5522_TEXT_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType));
    const mimeType = imageMimeType || textImageMimeType || (available.includes('text/plain') ? 'text/plain' : '');
    if (!mimeType) return null;
    return {
      mimeType,
      mimeTypes: [...available],
      loc: state.loc,
      pw: state.pw,
      passwordKey: state.passwordKey,
      name: 'Paste event'
    };
  }

  function finishOsc5522Read(metadata) {
    const key = sanitizeOsc5522Id(metadata.id) || DEFAULT_RESPONSE_ID;
    const state = reads.get(key);
    reads.delete(key);
    const image = imageFromOsc5522State(state);
    const pasteRequest = choosePasteRequestFromOsc5522State(state);
    const mimeTypes = state && state.isMimeListQuery ? [...state.availableMimeTypes] : [];
    const unsupportedPasteNotification = state && state.isPasteNotification && !pasteRequest
      ? {
        mimeTypes: [...state.availableMimeTypes],
        loc: state.loc,
        pw: state.pw,
        passwordKey: state.passwordKey
      }
      : null;
    return {
      image,
      text: image ? null : textFromOsc5522State(state),
      pasteRequest,
      mimeTypes,
      unsupportedPasteNotification
    };
  }

  function consumeOsc52Body(body, output) {
    output.progress = true;
    const parsed = parseOsc52Body(body);
    const image = parsed && decodeTerminalClipboardImagePayload(parsed.payload, { maxBytes });
    output.completed = true;
    if (image) {
      output.images.push(image);
    } else {
      output.errors.push(createTerminalClipboardError('ssh_clip_terminal_clipboard_no_image'));
    }
  }

  function consumeOsc5522Body(body, output) {
    const parsed = parseOsc5522Body(body);
    if (parsed.metadata.type !== 'read') return;
    const status = String(parsed.metadata.status || '').trim().toUpperCase();
    if (!status) return;
    output.progress = true;
    if (status === 'OK') {
      const state = getReadState(parsed.metadata.id);
      trackOsc5522PasteMetadata(state, parsed.metadata);
      return;
    }
    if (status === 'DATA') {
      appendOsc5522Data(parsed.metadata, parsed.payload, parsed.hasPayload);
      return;
    }
    output.completed = true;
    if (status === 'DONE') {
      const finished = finishOsc5522Read(parsed.metadata);
      if (finished.image) output.images.push(finished.image);
      if (finished.text) output.textPastes.push(finished.text);
      if (finished.pasteRequest) output.pasteRequests.push(finished.pasteRequest);
      if (finished.mimeTypes.length > 0) output.mimeLists.push(finished.mimeTypes);
      if (finished.unsupportedPasteNotification) {
        output.unsupportedPasteNotifications.push(finished.unsupportedPasteNotification);
      }
      if (
        !finished.image
        && !finished.text
        && !finished.pasteRequest
        && finished.mimeTypes.length === 0
        && !finished.unsupportedPasteNotification
      ) {
        output.errors.push(createTerminalClipboardError('ssh_clip_terminal_clipboard_no_image'));
      }
      return;
    }
    reads.delete(sanitizeOsc5522Id(parsed.metadata.id) || DEFAULT_RESPONSE_ID);
    output.errors.push(errorForOsc5522Status(status));
  }

  function consumePasteEventsSupportResponse(output) {
    const match = buffer.match(/^\x1b\[\?5522;([0-9]+)\$y/);
    if (!match) {
      if (/^\x1b\[\?5522;[0-9]*\$?y?$/.test(buffer)) return false;
      buffer = buffer.slice(1);
      return true;
    }
    output.pasteEventsSupport = parsePasteEventsSupportResponse(match[0]);
    output.completed = true;
    output.progress = true;
    buffer = buffer.slice(match[0].length);
    return true;
  }

  function consume(data) {
    const input = Buffer.isBuffer(data) ? data.toString('latin1') : String(data || '');
    buffer += input;
    resetOversizedBuffer();

    const passthroughParts = [];
    const output = {
      passthrough: null,
      images: [],
      textPastes: [],
      pasteRequests: [],
      unsupportedPasteNotifications: [],
      mimeLists: [],
      pasteEventsSupport: null,
      errors: [],
      completed: false,
      progress: false
    };

    while (buffer) {
      const match = findNextProtocolStart(buffer);
      if (!match) {
        const suffix = longestProtocolPrefixSuffix(buffer);
        if (suffix > 0) {
          passthroughParts.push(buffer.slice(0, buffer.length - suffix));
          buffer = buffer.slice(buffer.length - suffix);
        } else {
          passthroughParts.push(buffer);
          buffer = '';
        }
        break;
      }

      if (match.index > 0) {
        passthroughParts.push(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index);
      }

      if (match.protocol === 'paste_events_support') {
        if (!consumePasteEventsSupportResponse(output)) break;
        continue;
      }

      const bodyStart = match.prefix.length;
      const belIndex = buffer.indexOf('\x07', bodyStart);
      const stIndex = buffer.indexOf(STRING_TERMINATOR, bodyStart);
      const end = belIndex >= 0 && stIndex >= 0
        ? Math.min(belIndex, stIndex)
        : Math.max(belIndex, stIndex);
      if (end < 0) break;

      const terminatorLength = stIndex >= 0 && stIndex === end ? 2 : 1;
      const body = buffer.slice(bodyStart, end);
      buffer = buffer.slice(end + terminatorLength);

      try {
        if (match.protocol === 'osc5522') {
          consumeOsc5522Body(body, output);
        } else {
          consumeOsc52Body(body, output);
        }
      } catch (error) {
        output.completed = true;
        output.errors.push(error);
      }
    }

    const passthroughText = passthroughParts.join('');
    output.passthrough = passthroughText ? Buffer.from(passthroughText, 'latin1') : null;
    return output;
  }

  return {
    consume
  };
}

module.exports = {
  OSC52_PREFIX,
  OSC5522_IMAGE_MIME_TYPES,
  OSC5522_PREFIX,
  OSC5522_TARGETS_MIME,
  OSC5522_TEXT_IMAGE_MIME_TYPES,
  BEL_TERMINATOR,
  PASTE_EVENTS_5522_DISABLE,
  PASTE_EVENTS_5522_ENABLE,
  PASTE_EVENTS_5522_SUPPORT_QUERY,
  STRING_TERMINATOR,
  TMUX_PASSTHROUGH_PREFIX,
  buildOsc52ClipboardReadQuery,
  buildOsc5522ClipboardListMimeTypesQuery,
  buildOsc5522ClipboardReadMimeQuery,
  buildOsc5522ClipboardReadImageQuery,
  buildTerminalClipboardPasteEventsModeSequence,
  buildTerminalClipboardPasteEventsSupportQuery,
  createTerminalClipboardImageParser,
  decodeTerminalClipboardImagePayload,
  parsePasteEventsSupportResponse,
  wrapTerminalEscapeForTmuxPassthrough
};
