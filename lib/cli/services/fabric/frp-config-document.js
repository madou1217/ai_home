'use strict';

const { createFrpError } = require('./frp-config-errors');
const {
  validateCanonicalFabricServerId
} = require('../../../server/fabric-server-id');

const AIH_FRP_NAME_PREFIX = 'aih-';
const DEFAULT_WEB_SERVER_PORT = 7400;
const DEFAULT_LOCAL_SERVER_PORT = 9527;

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function splitTomlDocument(content) {
  const source = String(content == null ? '' : content);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { lines, newline };
}

function joinTomlDocument(lines, newline) {
  return `${lines.join(newline)}${newline}`;
}

function isTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(String(line || ''));
}

function tableName(line) {
  const match = String(line || '').match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/);
  return match ? match[1].trim() : '';
}

function assignmentMatch(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(line || '').match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`));
}

function scanArrayEnd(lines, startIndex) {
  let depth = 0;
  let started = false;
  let quote = '';
  let escaped = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (quote) {
        if (quote === '"' && escaped) {
          escaped = false;
          continue;
        }
        if (quote === '"' && char === '\\') {
          escaped = true;
          continue;
        }
        if (char === quote) quote = '';
        continue;
      }
      if (char === '#') break;
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '[') {
        depth += 1;
        started = true;
      } else if (char === ']') {
        depth -= 1;
        if (started && depth === 0) return index;
      }
    }
  }
  throw createFrpError('frpc_includes_invalid', 'frpc includes must be a TOML string array');
}

function decodeBasicTomlString(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw createFrpError('frpc_toml_string_invalid', 'Invalid TOML basic string');
  }
}

function stripTomlComments(value) {
  const source = String(value || '');
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      output += char;
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === '#') {
      while (index + 1 < source.length && source[index + 1] !== '\n') index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function parseTomlStrings(value) {
  const strings = [];
  const source = stripTomlComments(value);
  for (let index = 0; index < source.length;) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let escaped = false;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) break;
    }
    if (cursor >= source.length) {
      throw createFrpError('frpc_toml_string_invalid', 'Unterminated TOML string');
    }
    const raw = source.slice(index, cursor + 1);
    strings.push(quote === '"' ? decodeBasicTomlString(raw) : raw.slice(1, -1));
    index = cursor + 1;
  }
  return strings;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function findFirstTableIndex(lines) {
  const index = lines.findIndex(isTableHeader);
  return index === -1 ? lines.length : index;
}

function ensureInclude(lines, includePattern) {
  const firstTableIndex = findFirstTableIndex(lines);
  let includeIndex = -1;
  for (let index = 0; index < firstTableIndex; index += 1) {
    if (assignmentMatch(lines[index], 'includes')) {
      includeIndex = index;
      break;
    }
  }
  if (includeIndex === -1) {
    lines.unshift(`includes = [${tomlString(includePattern)}]`, '');
    return true;
  }

  const endIndex = scanArrayEnd(lines, includeIndex);
  const source = lines.slice(includeIndex, endIndex + 1).join('\n');
  const values = unique([...parseTomlStrings(source), includePattern]);
  const replacement = `includes = [${values.map(tomlString).join(', ')}]`;
  if (endIndex === includeIndex && lines[includeIndex] === replacement) return false;
  lines.splice(includeIndex, endIndex - includeIndex + 1, replacement);
  return true;
}

function stripTomlComment(value) {
  return stripTomlComments(value).trim();
}

function parseTomlScalarString(value) {
  const normalized = stripTomlComment(value);
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return decodeBasicTomlString(normalized);
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1);
  }
  throw createFrpError('frpc_web_server_addr_invalid', 'webServer.addr must be a TOML string');
}

function isLoopbackHost(value) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(value || '').trim().toLowerCase());
}

function assertLoopbackAssignment(match) {
  const address = parseTomlScalarString(match[1]);
  if (!isLoopbackHost(address)) {
    throw createFrpError(
      'frpc_web_server_not_loopback',
      'frpc webServer must listen on loopback only',
      { address }
    );
  }
}

function ensureWebServerTable(lines, port) {
  const tableIndex = lines.findIndex((line) => tableName(line) === 'webServer');
  if (tableIndex !== -1) {
    let endIndex = lines.length;
    for (let index = tableIndex + 1; index < lines.length; index += 1) {
      if (isTableHeader(lines[index])) {
        endIndex = index;
        break;
      }
    }
    let addrIndex = -1;
    let portIndex = -1;
    for (let index = tableIndex + 1; index < endIndex; index += 1) {
      const addrMatch = assignmentMatch(lines[index], 'addr');
      if (addrMatch) {
        assertLoopbackAssignment(addrMatch);
        addrIndex = index;
      }
      if (assignmentMatch(lines[index], 'port')) portIndex = index;
    }
    let changed = false;
    if (addrIndex === -1) {
      lines.splice(tableIndex + 1, 0, 'addr = "127.0.0.1"');
      addrIndex = tableIndex + 1;
      changed = true;
    }
    if (portIndex === -1) {
      lines.splice(addrIndex + 1, 0, `port = ${port}`);
      changed = true;
    }
    return changed;
  }

  const firstTableIndex = findFirstTableIndex(lines);
  let dottedAddrIndex = -1;
  let dottedPortIndex = -1;
  let inlineWebServerIndex = -1;
  for (let index = 0; index < firstTableIndex; index += 1) {
    const addrMatch = assignmentMatch(lines[index], 'webServer.addr');
    if (addrMatch) {
      assertLoopbackAssignment(addrMatch);
      dottedAddrIndex = index;
    }
    if (assignmentMatch(lines[index], 'webServer.port')) dottedPortIndex = index;
    if (assignmentMatch(lines[index], 'webServer')) inlineWebServerIndex = index;
  }
  if (inlineWebServerIndex !== -1) {
    throw createFrpError(
      'frpc_web_server_unsupported',
      'Inline webServer TOML cannot be safely managed'
    );
  }
  if (dottedAddrIndex !== -1 || dottedPortIndex !== -1) {
    let changed = false;
    const insertAt = dottedAddrIndex !== -1
      ? dottedAddrIndex
      : dottedPortIndex;
    if (dottedAddrIndex === -1) {
      lines.splice(insertAt, 0, 'webServer.addr = "127.0.0.1"');
      dottedAddrIndex = insertAt;
      changed = true;
    }
    if (dottedPortIndex === -1) {
      lines.splice(dottedAddrIndex + 1, 0, `webServer.port = ${port}`);
      changed = true;
    }
    return changed;
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('[webServer]', 'addr = "127.0.0.1"', `port = ${port}`);
  return true;
}

function normalizePort(value, fallback, field) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw createFrpError('frp_port_invalid', `${field} must be an integer between 1 and 65535`, { field });
  }
  return parsed;
}

function prepareFrpcMainConfig(content, options = {}) {
  const includePattern = String(options.includePattern || '').trim();
  if (!includePattern) {
    throw createFrpError('frpc_include_pattern_required', 'AIH frpc include pattern is required');
  }
  const port = normalizePort(options.webServerPort, DEFAULT_WEB_SERVER_PORT, 'webServerPort');
  const original = String(content == null ? '' : content);
  const { lines, newline } = splitTomlDocument(original);
  const includeAdded = ensureInclude(lines, includePattern);
  const webServerAdded = ensureWebServerTable(lines, port);
  const next = joinTomlDocument(lines, newline);
  return {
    content: next,
    changed: next !== original,
    includeAdded,
    webServerAdded
  };
}

function normalizeServerId(value) {
  const raw = String(value || '');
  const serverId = validateCanonicalFabricServerId(raw);
  if (!serverId || serverId !== raw) {
    throw createFrpError('frp_server_id_invalid', 'serverId must be a safe FRP identifier');
  }
  return serverId;
}

function assertAihOwnedName(name) {
  const normalized = String(name || '').trim();
  if (!normalized.startsWith(AIH_FRP_NAME_PREFIX)) {
    throw createFrpError(
      'frp_proxy_not_aih_owned',
      `AIH can manage only ${AIH_FRP_NAME_PREFIX} prefixed FRP entries`,
      { name: normalized }
    );
  }
  return normalized;
}

function resolveProxyName(options, serverId) {
  const requested = String(options.proxyName || '').trim();
  return assertAihOwnedName(requested || `${AIH_FRP_NAME_PREFIX}local-${serverId}`);
}

function normalizeSecret(value) {
  const secret = String(value || '');
  if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret)) {
    throw createFrpError('frp_secret_key_invalid', 'A non-empty single-line FRP secretKey is required');
  }
  return secret;
}

function normalizeLoopback(value, field) {
  const address = String(value || '127.0.0.1').trim();
  if (!isLoopbackHost(address)) {
    throw createFrpError('frp_address_not_loopback', `${field} must be a loopback address`, { field, address });
  }
  return address;
}

function renderProviderFragment(options) {
  return [
    '[[proxies]]',
    `name = ${tomlString(options.proxyName)}`,
    'type = "stcp"',
    `localIP = ${tomlString(options.localIP)}`,
    `localPort = ${options.localPort}`,
    `secretKey = ${tomlString(options.secretKey)}`,
    ''
  ].join('\n');
}

function renderVisitorFragment(options) {
  return [
    '[[visitors]]',
    `name = ${tomlString(options.visitorName)}`,
    'type = "stcp"',
    `serverName = ${tomlString(options.proxyName)}`,
    `secretKey = ${tomlString(options.secretKey)}`,
    `bindAddr = ${tomlString(options.bindAddr)}`,
    `bindPort = ${options.bindPort}`,
    ''
  ].join('\n');
}

function normalizeManagedRouteIdentity(options = {}) {
  const role = String(options.role || '').trim().toLowerCase();
  if (role !== 'provider' && role !== 'visitor') {
    throw createFrpError('frp_role_invalid', 'role must be provider or visitor');
  }
  const serverId = normalizeServerId(options.serverId);
  return { role, serverId };
}

function normalizeFragmentOptions(options = {}) {
  const { role, serverId } = normalizeManagedRouteIdentity(options);
  const proxyName = resolveProxyName(options, serverId);
  const secretKey = normalizeSecret(options.secretKey);
  if (role === 'provider') {
    return {
      role,
      serverId,
      proxyName,
      secretKey,
      localIP: normalizeLoopback(options.localIP, 'localIP'),
      localPort: normalizePort(options.localPort, DEFAULT_LOCAL_SERVER_PORT, 'localPort')
    };
  }
  return {
    role,
    serverId,
    proxyName,
    visitorName: assertAihOwnedName(
      String(options.visitorName || '').trim() || `${proxyName}-visitor`
    ),
    secretKey,
    bindAddr: normalizeLoopback(options.bindAddr, 'bindAddr'),
    bindPort: normalizePort(options.bindPort, DEFAULT_LOCAL_SERVER_PORT, 'bindPort')
  };
}

function renderAihFrpcFragment(options = {}) {
  const normalized = normalizeFragmentOptions(options);
  return normalized.role === 'provider'
    ? renderProviderFragment(normalized)
    : renderVisitorFragment(normalized);
}

module.exports = {
  AIH_FRP_NAME_PREFIX,
  DEFAULT_LOCAL_SERVER_PORT,
  DEFAULT_WEB_SERVER_PORT,
  assertAihOwnedName,
  normalizeFragmentOptions,
  normalizeManagedRouteIdentity,
  prepareFrpcMainConfig,
  renderAihFrpcFragment
};
