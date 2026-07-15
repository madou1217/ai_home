'use strict';

const fsBase = require('node:fs');
const httpBase = require('node:http');
const osBase = require('node:os');
const pathBase = require('node:path');
const { validateImageBuffer } = require('./image-data');
const { DEFAULT_MAX_BYTES } = require('./frames');

const DEFAULT_CLIP_AGENT_PORT = 17652;
const DEFAULT_CLIP_AGENT_TIMEOUT_MS = 1200;

function parsePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function createClipAgentError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function notifyUnavailable(callback, payload) {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (_error) {}
}

function describeEndpoint(endpoint) {
  if (!endpoint) return {};
  if (endpoint.url) return { url: endpoint.url };
  return { socketPath: endpoint.socketPath };
}

function safeUserName(osImpl) {
  try {
    const info = osImpl.userInfo();
    const user = String(info && info.username || '').trim();
    return user.replace(/[^A-Za-z0-9._-]+/g, '-') || 'user';
  } catch (_error) {
    return 'user';
  }
}

function buildDefaultClipAgentSocketPath(options = {}) {
  const osImpl = options.os || osBase;
  const pathImpl = options.path || pathBase;
  return pathImpl.join(osImpl.tmpdir(), `aih-clip-${safeUserName(osImpl)}.sock`);
}

function normalizeEndpoint(options = {}) {
  const env = options.env || process.env || {};
  const socketPath = String(options.socketPath || env.AIH_SSH_CLIP_AGENT_SOCKET || '').trim();
  const url = String(options.url || env.AIH_SSH_CLIP_AGENT_URL || '').trim();
  if (url) return { url };
  return {
    socketPath: socketPath || buildDefaultClipAgentSocketPath(options)
  };
}

function buildRequestOptions(endpoint, maxBytes) {
  const headers = {
    accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff',
    'x-aih-clip-max-bytes': String(maxBytes)
  };
  if (endpoint.url) {
    const url = new URL(endpoint.url);
    const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '/image';
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || DEFAULT_CLIP_AGENT_PORT,
      method: 'GET',
      path: `${pathname}${url.search || ''}`,
      headers
    };
  }
  return {
    socketPath: endpoint.socketPath,
    method: 'GET',
    path: '/image',
    headers
  };
}

function shouldSkipMissingEndpoint(endpoint, fsImpl) {
  if (!endpoint.socketPath) return false;
  try {
    return !fsImpl.existsSync(endpoint.socketPath);
  } catch (_error) {
    return true;
  }
}

function collectResponseImage(res, maxBytes, resolve, onUnavailable, endpoint) {
  if (res.statusCode === 204) {
    res.resume();
    notifyUnavailable(onUnavailable, {
      code: 'ssh_clip_agent_no_image',
      ...describeEndpoint(endpoint)
    });
    resolve(null);
    return;
  }
  if (res.statusCode === 404) {
    res.resume();
    notifyUnavailable(onUnavailable, {
      code: 'ssh_clip_agent_not_found',
      ...describeEndpoint(endpoint)
    });
    resolve(null);
    return;
  }
  if (res.statusCode !== 200) {
    res.resume();
    notifyUnavailable(onUnavailable, {
      code: 'ssh_clip_agent_http_status',
      statusCode: res.statusCode,
      ...describeEndpoint(endpoint)
    });
    resolve(null);
    return;
  }

  const chunks = [];
  let byteLength = 0;
  res.on('data', (chunk) => {
    byteLength += chunk.length;
    if (byteLength > maxBytes) {
      notifyUnavailable(onUnavailable, {
        code: 'ssh_clip_agent_image_too_large',
        ...describeEndpoint(endpoint)
      });
      resolve(null);
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const info = validateImageBuffer(buffer, {
        mimeType: String(res.headers['content-type'] || '').split(';')[0],
        maxBytes
      });
      resolve({
        buffer,
        mimeType: info.mimeType,
        sha256: info.sha256,
        byteLength: info.byteLength
      });
    } catch (error) {
      notifyUnavailable(onUnavailable, {
        code: String((error && error.code) || 'ssh_clip_agent_invalid_image'),
        ...describeEndpoint(endpoint)
      });
      resolve(null);
    }
  });
}

function fetchSshClipAgentImage(options = {}) {
  const env = options.env || process.env || {};
  const onUnavailable = options.onUnavailable;
  if (String(env.AIH_SSH_CLIP_AGENT || '1') === '0') {
    notifyUnavailable(onUnavailable, { code: 'ssh_clip_agent_disabled' });
    return Promise.resolve(null);
  }

  const fsImpl = options.fs || fsBase;
  const httpImpl = options.http || httpBase;
  const maxBytes = parsePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const timeoutMs = parsePositiveInteger(options.timeoutMs || env.AIH_SSH_CLIP_AGENT_TIMEOUT_MS, DEFAULT_CLIP_AGENT_TIMEOUT_MS);
  const endpoint = normalizeEndpoint(options);
  if (shouldSkipMissingEndpoint(endpoint, fsImpl)) {
    notifyUnavailable(onUnavailable, {
      code: 'ssh_clip_agent_socket_missing',
      ...describeEndpoint(endpoint)
    });
    return Promise.resolve(null);
  }
  let requestOptions = null;
  try {
    requestOptions = buildRequestOptions(endpoint, maxBytes);
  } catch (error) {
    notifyUnavailable(onUnavailable, {
      code: String((error && error.code) || 'ssh_clip_agent_bad_endpoint'),
      ...describeEndpoint(endpoint)
    });
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    const request = httpImpl.request(requestOptions, (res) => {
      collectResponseImage(res, maxBytes, finish, onUnavailable, endpoint);
    });
    request.setTimeout(timeoutMs, () => {
      notifyUnavailable(onUnavailable, {
        code: 'ssh_clip_agent_timeout',
        ...describeEndpoint(endpoint)
      });
      finish(null);
      request.destroy(createClipAgentError('ssh_clip_agent_timeout'));
    });
    request.on('error', (error) => {
      if (!settled) {
        notifyUnavailable(onUnavailable, {
          code: String((error && error.code) || 'ssh_clip_agent_connection_failed'),
          ...describeEndpoint(endpoint)
        });
      }
      finish(null);
    });
    request.end();
  });
}

module.exports = {
  DEFAULT_CLIP_AGENT_PORT,
  DEFAULT_CLIP_AGENT_TIMEOUT_MS,
  buildDefaultClipAgentSocketPath,
  fetchSshClipAgentImage
};
