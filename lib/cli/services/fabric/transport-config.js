'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  readJsonValue,
  writeJsonValue
} = require('../../../server/app-state-store');
const {
  normalizeText,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath
} = require('./server-profile-client');

const TRANSPORT_CONFIG_KEY = 'fabric_transport_config';
const DEFAULT_CONFIG_VERSION = 1;

function nowMs() {
  return Date.now();
}

function emptyTransportConfig() {
  return {
    version: DEFAULT_CONFIG_VERSION,
    turn: {
      iceServers: [],
      username: '',
      credential: '',
      updatedAt: 0
    },
    webtransport: {
      url: '',
      pageUrl: '',
      updatedAt: 0
    },
    updatedAt: 0
  };
}

function normalizeStringArray(value, maxLength = 2048) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)));
}

function normalizeTurnUrl(value, flag = '--turn-ice-server') {
  const raw = normalizeText(value, 2048);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'turn:' && parsed.protocol !== 'turns:') {
      throw new Error('invalid_protocol');
    }
    parsed.hash = '';
    return parsed.toString();
  } catch (_error) {
    const error = new Error(`${flag} must be a valid turn: or turns: URL`);
    error.code = 'invalid_option';
    throw error;
  }
}

function normalizeHttpUrl(value, flag) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid_protocol');
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    const error = new Error(`${flag} must be a valid http(s) URL`);
    error.code = 'invalid_option';
    throw error;
  }
}

function normalizeTransportConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const base = emptyTransportConfig();
  const turn = source.turn && typeof source.turn === 'object' ? source.turn : {};
  const webtransport = source.webtransport && typeof source.webtransport === 'object'
    ? source.webtransport
    : {};

  return {
    version: DEFAULT_CONFIG_VERSION,
    turn: {
      iceServers: normalizeStringArray(turn.iceServers)
        .map((url) => normalizeTurnUrl(url))
        .filter(Boolean),
      username: normalizeText(turn.username, 256),
      credential: String(turn.credential == null ? '' : turn.credential),
      updatedAt: Number(turn.updatedAt) || 0
    },
    webtransport: {
      url: normalizeHttpUrl(webtransport.url, '--webtransport-url'),
      pageUrl: normalizeHttpUrl(webtransport.pageUrl, '--webtransport-page-url'),
      updatedAt: Number(webtransport.updatedAt) || 0
    },
    updatedAt: Number(source.updatedAt) || base.updatedAt
  };
}

function publicTransportConfig(config) {
  const normalized = normalizeTransportConfig(config);
  return {
    version: normalized.version,
    turn: {
      iceServers: normalized.turn.iceServers.slice(),
      usernamePresent: Boolean(normalized.turn.username),
      credentialPresent: Boolean(normalized.turn.credential),
      configured: normalized.turn.iceServers.length > 0
        && Boolean(normalized.turn.username)
        && Boolean(normalized.turn.credential),
      updatedAt: normalized.turn.updatedAt
    },
    webtransport: {
      url: normalized.webtransport.url,
      pageUrl: normalized.webtransport.pageUrl,
      configured: Boolean(normalized.webtransport.url),
      updatedAt: normalized.webtransport.updatedAt
    },
    updatedAt: normalized.updatedAt
  };
}

function resolveAiHomeDir(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const explicit = normalizeText(options.aiHomeDir || deps.aiHomeDir || env.AIH_HOME || env.AI_HOME, 2048);
  return explicit ? resolveLocalPath(explicit) : resolveDefaultAiHomeDir(env);
}

function readTransportConfig(options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const aiHomeDir = resolveAiHomeDir(options, deps);
  const raw = (deps.readJsonValue || readJsonValue)(fsImpl, aiHomeDir, TRANSPORT_CONFIG_KEY, deps);
  return normalizeTransportConfig(raw);
}

function writeTransportConfig(config, options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const aiHomeDir = resolveAiHomeDir(options, deps);
  const normalized = normalizeTransportConfig(config);
  (deps.writeJsonValue || writeJsonValue)(fsImpl, aiHomeDir, TRANSPORT_CONFIG_KEY, normalized, deps);
  return normalized;
}

function mergeTransportConfigPatch(current, patch) {
  const next = normalizeTransportConfig(current);
  const input = patch && typeof patch === 'object' ? patch : {};
  let changed = false;

  if (input.turn && typeof input.turn === 'object') {
    if (Object.prototype.hasOwnProperty.call(input.turn, 'iceServers')) {
      next.turn.iceServers = normalizeStringArray(input.turn.iceServers)
        .map((url) => normalizeTurnUrl(url))
        .filter(Boolean);
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(input.turn, 'username')) {
      next.turn.username = normalizeText(input.turn.username, 256);
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(input.turn, 'credential')) {
      next.turn.credential = String(input.turn.credential == null ? '' : input.turn.credential);
      changed = true;
    }
    if (changed) next.turn.updatedAt = nowMs();
  }

  if (input.webtransport && typeof input.webtransport === 'object') {
    let webtransportChanged = false;
    if (Object.prototype.hasOwnProperty.call(input.webtransport, 'url')) {
      next.webtransport.url = normalizeHttpUrl(input.webtransport.url, '--webtransport-url');
      webtransportChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(input.webtransport, 'pageUrl')) {
      next.webtransport.pageUrl = normalizeHttpUrl(input.webtransport.pageUrl, '--webtransport-page-url');
      webtransportChanged = true;
    }
    if (webtransportChanged) {
      next.webtransport.updatedAt = nowMs();
      changed = true;
    }
  }

  if (changed) next.updatedAt = nowMs();
  return next;
}

function clearTransportConfig(current, target) {
  const next = normalizeTransportConfig(current);
  const clearedAt = nowMs();
  if (target.all || target.turn) {
    next.turn = { ...emptyTransportConfig().turn, updatedAt: clearedAt };
  }
  if (target.all || target.webtransport) {
    next.webtransport = { ...emptyTransportConfig().webtransport, updatedAt: clearedAt };
  }
  next.updatedAt = clearedAt;
  if (
    next.turn.iceServers.length === 0
    && !next.turn.username
    && !next.turn.credential
    && !next.webtransport.url
    && !next.webtransport.pageUrl
  ) {
    return emptyTransportConfig();
  }
  return next;
}

function parseConfigCommandArgs(argv = [], env = process.env) {
  const tokens = Array.isArray(argv) ? argv.slice() : [];
  const first = normalizeText(tokens[0], 64);
  const action = ['show', 'set', 'clear'].includes(first) ? first : 'show';
  const args = action === first ? tokens.slice(1) : tokens;
  const options = {
    action,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    patch: {},
    clear: {
      all: false,
      turn: false,
      webtransport: false
    }
  };

  for (let index = 0; index < args.length;) {
    const token = normalizeText(args[index], 256);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--ai-home-dir' || token.startsWith('--ai-home-dir=')) {
      const next = readOptionValue(args, index, '--ai-home-dir');
      options.aiHomeDir = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (action === 'set' && (token === '--turn-ice-server' || token.startsWith('--turn-ice-server='))) {
      const next = readOptionValue(args, index, '--turn-ice-server');
      options.patch.turn = options.patch.turn || {};
      options.patch.turn.iceServers = options.patch.turn.iceServers || [];
      options.patch.turn.iceServers.push(normalizeTurnUrl(next.value));
      index += next.consumed;
      continue;
    }
    if (action === 'set' && (token === '--turn-username' || token.startsWith('--turn-username='))) {
      const next = readOptionValue(args, index, '--turn-username');
      options.patch.turn = options.patch.turn || {};
      options.patch.turn.username = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (action === 'set' && (token === '--turn-credential' || token.startsWith('--turn-credential='))) {
      const next = readOptionValue(args, index, '--turn-credential');
      options.patch.turn = options.patch.turn || {};
      options.patch.turn.credential = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (action === 'set' && (token === '--webtransport-url' || token.startsWith('--webtransport-url='))) {
      const next = readOptionValue(args, index, '--webtransport-url');
      options.patch.webtransport = options.patch.webtransport || {};
      options.patch.webtransport.url = normalizeHttpUrl(next.value, '--webtransport-url');
      index += next.consumed;
      continue;
    }
    if (action === 'set' && (token === '--webtransport-page-url' || token.startsWith('--webtransport-page-url='))) {
      const next = readOptionValue(args, index, '--webtransport-page-url');
      options.patch.webtransport = options.patch.webtransport || {};
      options.patch.webtransport.pageUrl = normalizeHttpUrl(next.value, '--webtransport-page-url');
      index += next.consumed;
      continue;
    }
    if (action === 'clear' && token === '--all') {
      options.clear.all = true;
      index += 1;
      continue;
    }
    if (action === 'clear' && token === '--turn') {
      options.clear.turn = true;
      index += 1;
      continue;
    }
    if (action === 'clear' && token === '--webtransport') {
      options.clear.webtransport = true;
      index += 1;
      continue;
    }
    const error = new Error(`unknown option: ${token}`);
    error.code = 'invalid_option';
    throw error;
  }
  return options;
}

function hasPatch(patch) {
  return Boolean(patch && (
    patch.turn && Object.keys(patch.turn).length > 0
    || patch.webtransport && Object.keys(patch.webtransport).length > 0
  ));
}

function hasClearTarget(clear) {
  return Boolean(clear && (clear.all || clear.turn || clear.webtransport));
}

async function runFabricTransportConfigCommand(args = [], deps = {}) {
  const options = parseConfigCommandArgs(args, deps.env || process.env);
  const current = readTransportConfig({ aiHomeDir: options.aiHomeDir }, deps);
  let config = current;

  if (options.action === 'set') {
    if (!hasPatch(options.patch)) {
      const error = new Error('fabric transport config set requires at least one config option');
      error.code = 'invalid_option';
      throw error;
    }
    config = writeTransportConfig(
      mergeTransportConfigPatch(current, options.patch),
      { aiHomeDir: options.aiHomeDir },
      deps
    );
  }

  if (options.action === 'clear') {
    if (!hasClearTarget(options.clear)) {
      const error = new Error('fabric transport config clear requires --turn, --webtransport, or --all');
      error.code = 'invalid_option';
      throw error;
    }
    config = writeTransportConfig(
      clearTransportConfig(current, options.clear),
      { aiHomeDir: options.aiHomeDir },
      deps
    );
  }

  return {
    ok: true,
    json: options.json,
    action: options.action,
    aiHomeDir: resolveAiHomeDir({ aiHomeDir: options.aiHomeDir }, deps),
    config: publicTransportConfig(config)
  };
}

function formatFabricTransportConfigReport(report = {}) {
  const config = report.config || publicTransportConfig(emptyTransportConfig());
  const lines = [];
  lines.push('AIH Fabric transport config');
  lines.push(`  action: ${report.action || 'show'}`);
  lines.push(`  turn: configured=${config.turn && config.turn.configured ? 'yes' : 'no'}`);
  (config.turn && config.turn.iceServers || []).forEach((url) => {
    lines.push(`    - ${url}`);
  });
  lines.push(`    username: ${config.turn && config.turn.usernamePresent ? '<set>' : '<empty>'}`);
  lines.push(`    credential: ${config.turn && config.turn.credentialPresent ? '<redacted>' : '<empty>'}`);
  lines.push(`  webtransport: configured=${config.webtransport && config.webtransport.configured ? 'yes' : 'no'}`);
  lines.push(`    url: ${config.webtransport && config.webtransport.url || '<empty>'}`);
  lines.push(`    page_url: ${config.webtransport && config.webtransport.pageUrl || '<empty>'}`);
  return lines.join('\n');
}

function collectArgFlags(args = []) {
  return new Set((Array.isArray(args) ? args : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value.startsWith('--'))
    .map((value) => value.split('=')[0]));
}

function envHasAny(env = {}, names = []) {
  return names.some((name) => normalizeText(env[name], 4096));
}

function applyTransportConfigDefaults(options = {}, args = [], deps = {}) {
  const config = readTransportConfig({}, deps);
  const flags = collectArgFlags(args);
  const env = deps.env || process.env;
  const next = { ...options };
  const applied = [];

  if (
    config.turn.iceServers.length > 0
    && !flags.has('--turn-ice-server')
    && !envHasAny(env, ['AIH_TURN_ICE_SERVERS', 'AIH_TURN_ICE_SERVER'])
  ) {
    next.turnIceServers = config.turn.iceServers.slice();
    applied.push('turn.iceServers');
  }
  if (
    config.turn.username
    && !flags.has('--turn-username')
    && !envHasAny(env, ['AIH_TURN_USERNAME'])
  ) {
    next.turnUsername = config.turn.username;
    applied.push('turn.username');
  }
  if (
    config.turn.credential
    && !flags.has('--turn-credential')
    && !envHasAny(env, ['AIH_TURN_CREDENTIAL'])
  ) {
    next.turnCredential = config.turn.credential;
    applied.push('turn.credential');
  }
  if (
    config.webtransport.url
    && !flags.has('--webtransport-url')
    && !envHasAny(env, ['AIH_WEBTRANSPORT_URL', 'AIH_M6_WEBTRANSPORT_URL'])
  ) {
    next.webTransportUrl = config.webtransport.url;
    applied.push('webtransport.url');
  }
  if (
    config.webtransport.pageUrl
    && !flags.has('--webtransport-page-url')
    && !envHasAny(env, ['AIH_WEBTRANSPORT_PAGE_URL', 'AIH_M6_WEBTRANSPORT_PAGE_URL'])
  ) {
    next.webTransportPageUrl = config.webtransport.pageUrl;
    applied.push('webtransport.pageUrl');
  }

  return {
    options: next,
    source: {
      key: TRANSPORT_CONFIG_KEY,
      present: Boolean(config.updatedAt),
      applied,
      config: publicTransportConfig(config)
    }
  };
}

module.exports = {
  TRANSPORT_CONFIG_KEY,
  applyTransportConfigDefaults,
  clearTransportConfig,
  formatFabricTransportConfigReport,
  mergeTransportConfigPatch,
  normalizeTransportConfig,
  parseConfigCommandArgs,
  publicTransportConfig,
  readTransportConfig,
  runFabricTransportConfigCommand,
  writeTransportConfig
};
