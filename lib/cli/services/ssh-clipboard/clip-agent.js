'use strict';

const httpBase = require('node:http');
const { DEFAULT_CLIP_AGENT_PORT } = require('./clip-agent-client');
const { DEFAULT_MAX_BYTES } = require('./frames');
const { readClipboardImage } = require('./clipboard');
const { validateImageBuffer } = require('./image-data');

function parsePositiveInteger(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function parseClipAgentArgs(args = [], env = {}) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item || '')) : [];
  const action = String(tokens[1] || 'start').trim() || 'start';
  const options = {
    action,
    host: String(env.AIH_CLIP_AGENT_HOST || '127.0.0.1'),
    port: parsePositiveInteger(env.AIH_CLIP_AGENT_PORT, DEFAULT_CLIP_AGENT_PORT),
    maxBytes: parsePositiveInteger(env.AIH_SSH_CLIP_MAX_BYTES || env.AIH_CLIP_AGENT_MAX_BYTES, DEFAULT_MAX_BYTES)
  };

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--host') {
      options.host = String(tokens[index + 1] || '').trim() || options.host;
      index += 1;
    } else if (token === '--port') {
      options.port = parsePositiveInteger(tokens[index + 1], options.port);
      index += 1;
    } else if (token === '--max-bytes' || token === '--clip-max-bytes') {
      options.maxBytes = parsePositiveInteger(tokens[index + 1], options.maxBytes);
      index += 1;
    } else if (token === '--help' || token === '-h' || token === 'help') {
      options.help = true;
    }
  }

  return options;
}

function showClipAgentHelp(write) {
  write(`
\x1b[36mAI Home Clip Agent\x1b[0m - Non-zero-client clipboard image provider for SSH RemoteForward

\x1b[33mUsage:\x1b[0m
  aih clip-agent start [--host 127.0.0.1] [--port ${DEFAULT_CLIP_AGENT_PORT}]

\x1b[33mSSH config example:\x1b[0m
  Host my-aih-host
    RemoteForward /tmp/aih-clip-%r.sock 127.0.0.1:${DEFAULT_CLIP_AGENT_PORT}
    StreamLocalBindUnlink yes

\x1b[33mPriority:\x1b[0m
  Strict zero-client uses normal SSH plus terminal-native OSC 5522 / OSC 52 only.
  This agent is an explicit non-zero-client fallback. Enable it with AIH_SSH_CLIP_AGENT=1.
`);
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

function normalizeAgentImage(image, maxBytes) {
  const buffer = image && image.buffer;
  const info = validateImageBuffer(buffer, {
    mimeType: image && image.mimeType,
    maxBytes
  });
  return {
    buffer,
    mimeType: info.mimeType,
    byteLength: info.byteLength,
    sha256: image.sha256 || info.sha256
  };
}

function writeImage(res, image) {
  res.statusCode = 200;
  res.setHeader('content-type', image.mimeType);
  res.setHeader('content-length', String(image.byteLength));
  if (image.sha256) {
    res.setHeader('x-aih-clip-sha256', image.sha256);
  }
  res.end(image.buffer);
}

function createClipAgentServer(options = {}) {
  const readImage = options.readClipboardImage || readClipboardImage;
  const maxBytes = parsePositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  return (options.http || httpBase).createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { ok: true, service: 'aih-clip-agent' });
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/image') {
      writeJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    try {
      const requestedMaxBytes = parsePositiveInteger(req.headers['x-aih-clip-max-bytes'], maxBytes);
      const image = readImage({ maxBytes: Math.min(maxBytes, requestedMaxBytes) });
      if (!image) {
        res.statusCode = 204;
        res.end();
        return;
      }
      writeImage(res, normalizeAgentImage(image, Math.min(maxBytes, requestedMaxBytes)));
    } catch (error) {
      writeJson(res, 422, {
        ok: false,
        error: String((error && error.code) || (error && error.message) || error || 'clipboard_image_failed')
      });
    }
  });
}

async function runClipAgentCommand(rawArgs = [], deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const parsed = parseClipAgentArgs(args, processObj.env || {});
  if (parsed.help || parsed.action === '--help' || parsed.action === '-h' || parsed.action === 'help') {
    showClipAgentHelp((line) => consoleImpl.log(line));
    return 0;
  }
  if (parsed.action !== 'start') {
    consoleImpl.error(`\x1b[31m[aih clip-agent]\x1b[0m unknown action: ${parsed.action}`);
    showClipAgentHelp((line) => consoleImpl.error(line));
    return 1;
  }

  const server = createClipAgentServer({
    http: deps.http,
    readClipboardImage: deps.readClipboardImage,
    maxBytes: parsed.maxBytes
  });

  return new Promise((resolve) => {
    server.on('error', (error) => {
      consoleImpl.error(`\x1b[31m[aih clip-agent]\x1b[0m failed: ${String(error && error.message || error)}`);
      resolve(1);
    });
    server.listen(parsed.port, parsed.host, () => {
      const address = server.address();
      const host = address && address.address ? address.address : parsed.host;
      const port = address && address.port ? address.port : parsed.port;
      consoleImpl.log(`\x1b[36m[aih clip-agent]\x1b[0m listening on ${host}:${port}`);
      consoleImpl.log(`\x1b[90m[aih clip-agent]\x1b[0m non-zero-client ssh config: RemoteForward /tmp/aih-clip-%r.sock ${host}:${port}`);
    });
    server.on('close', () => resolve(0));
  });
}

module.exports = {
  createClipAgentServer,
  parseClipAgentArgs,
  runClipAgentCommand,
  showClipAgentHelp
};
