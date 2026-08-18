'use strict';

const http = require('node:http');
const https = require('node:https');
const {
  DEFAULT_RECEIVER_URL,
  MANAGED_HOOK_MARKER
} = require('./provider-session-hook-config');
const {
  PROVIDER_ACCOUNT_REF_ENV,
  normalizeProviderAccountRef
} = require('../runtime/provider-session-context');

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

const SAFE_SCALAR_FIELDS = Object.freeze([
  'session_id', 'sessionId', 'conversationId', 'conversation_id',
  'transcriptPath', 'transcript_path', 'projectPath', 'project_path',
  'projectDirName', 'project_dir_name', 'cwd', 'turn_id', 'turnId',
  'invocationNum', 'executionNum', 'stepIdx', 'timestamp', 'at',
  'eventName', 'hookEventName', 'hook_event_name', 'event', 'source'
]);
const SAFE_BOOLEAN_FIELDS = Object.freeze(['fullyIdle']);
const SAFE_PATH_ARRAY_FIELDS = Object.freeze(['workspacePaths', 'workspace_paths']);

function copySafeScalar(source, target, field) {
  if (!Object.prototype.hasOwnProperty.call(source, field)) return;
  const value = source[field];
  if (typeof value === 'number' && Number.isFinite(value)) {
    target[field] = value;
    return;
  }
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (text) target[field] = text.slice(0, 4096);
}

function sanitizeHookPayload(rawPayload) {
  const source = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? rawPayload
    : {};
  const payload = {};
  SAFE_SCALAR_FIELDS.forEach((field) => copySafeScalar(source, payload, field));
  SAFE_BOOLEAN_FIELDS.forEach((field) => {
    if (typeof source[field] === 'boolean') payload[field] = source[field];
  });
  SAFE_PATH_ARRAY_FIELDS.forEach((field) => {
    if (!Array.isArray(source[field])) return;
    const paths = source[field]
      .filter((value) => typeof value === 'string' && value.trim())
      .slice(0, 16)
      .map((value) => value.trim().slice(0, 4096));
    if (paths.length > 0) payload[field] = paths;
  });
  if (source.toolCall && typeof source.toolCall === 'object' && !Array.isArray(source.toolCall)) {
    payload.toolCall = {};
  }
  if (source.error !== undefined && source.error !== null && normalizeText(source.error)) {
    payload.error = true;
  }
  if (source.terminationReason !== undefined && source.terminationReason !== null && normalizeText(source.terminationReason)) {
    payload.terminationReason = normalizeText(source.terminationReason).toLowerCase() === 'error'
      ? 'error'
      : 'reported';
  }
  return payload;
}

function parseSenderArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const parsed = {
    provider: '',
    eventName: '',
    url: '',
    timeoutMs: 2000
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === MANAGED_HOOK_MARKER) continue;
    if (arg === '--provider' && i + 1 < args.length) {
      parsed.provider = normalizeText(args[i + 1]).toLowerCase();
      i += 1;
    } else if ((arg === '--event' || arg === '--eventName') && i + 1 < args.length) {
      parsed.eventName = normalizeText(args[i + 1]);
      i += 1;
    } else if (arg === '--url' && i + 1 < args.length) {
      parsed.url = normalizeText(args[i + 1]);
      i += 1;
    } else if (arg === '--timeout-ms' && i + 1 < args.length) {
      parsed.timeoutMs = Math.max(100, Number(args[i + 1]) || parsed.timeoutMs);
      i += 1;
    }
  }
  return parsed;
}

function buildHookReceiverBody(rawPayload, options = {}) {
  let parsedPayload = null;
  const text = normalizeText(rawPayload);
  if (text) {
    try {
      parsedPayload = JSON.parse(text);
    } catch (_error) {
      parsedPayload = null;
    }
  }
  const body = {
    provider: normalizeText(options.provider).toLowerCase(),
    eventName: normalizeText(options.eventName),
    payload: sanitizeHookPayload(parsedPayload)
  };
  const correlationId = normalizeText(options.correlationId);
  if (correlationId) body.correlationId = correlationId;
  const accountRef = normalizeProviderAccountRef(options.accountRef);
  if (accountRef) body.accountRef = accountRef;
  return body;
}

function buildHookNoopOutput(providerRaw, eventNameRaw) {
  const provider = normalizeText(providerRaw).toLowerCase();
  const eventName = normalizeText(eventNameRaw);
  if (provider === 'agy') {
    if (eventName === 'Stop') return { decision: '' };
    if (eventName === 'PreToolUse') return { decision: 'allow' };
    return {};
  }
  return {};
}

function postJson(urlRaw, payload, options = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(normalizeText(urlRaw) || DEFAULT_RECEIVER_URL);
    } catch (_error) {
      resolve({ ok: false, error: 'invalid_url' });
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length)
      },
      timeout: Math.max(100, Number(options.timeoutMs) || 2000)
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (responseBody.length < 256 * 1024) responseBody += chunk;
      });
      res.on('end', () => {
        let json;
        try {
          json = responseBody ? JSON.parse(responseBody) : undefined;
        } catch (_error) {
          json = undefined;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          ...(json === undefined ? {} : { json })
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      resolve({
        ok: false,
        error: normalizeText(error && error.message) || 'request_failed'
      });
    });
    req.end(body);
  });
}

async function runProviderSessionHookSender(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : [];
  const stdin = normalizeText(options.stdin);
  const parsed = {
    ...parseSenderArgs(argv),
    ...options
  };
  const provider = normalizeText(parsed.provider).toLowerCase();
  const eventName = normalizeText(parsed.eventName || parsed.event);
  const processEnv = parsed.processEnv && typeof parsed.processEnv === 'object'
    ? parsed.processEnv
    : process.env;
  const body = buildHookReceiverBody(stdin, {
    provider,
    eventName,
    correlationId: processEnv.AIH_PROVIDER_SESSION_CORRELATION_ID,
    accountRef: processEnv[PROVIDER_ACCOUNT_REF_ENV]
  });
  const post = typeof parsed.postJson === 'function' ? parsed.postJson : postJson;
  const delivery = await post(parsed.url || DEFAULT_RECEIVER_URL, body, {
    timeoutMs: parsed.timeoutMs
  });
  return {
    delivery,
    stdout: JSON.stringify(buildHookNoopOutput(provider, eventName)),
    stderr: delivery && delivery.ok
      ? ''
      : `[aih-provider-session-hook] delivery failed provider=${provider || 'unknown'} event=${eventName || 'unknown'} error=${normalizeText(delivery && (delivery.error || delivery.statusCode)) || 'unknown'}\n`
  };
}

module.exports = {
  buildHookNoopOutput,
  buildHookReceiverBody,
  parseSenderArgs,
  postJson,
  runProviderSessionHookSender,
  sanitizeHookPayload
};
