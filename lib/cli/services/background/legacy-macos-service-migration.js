'use strict';

const {
  hasSecretBearingArgument
} = require('./supervisor-state-store');
const {
  formatPersistentTransportHeartbeat,
  parseTransportHeartbeat
} = require('../fabric/registry-heartbeat');

const LEGACY_SERVICE_TYPES = Object.freeze([
  Object.freeze({
    labelPrefix: 'com.clawdcodex.ai_home.node-relay.',
    command: Object.freeze(['node', 'relay', 'connect']),
    componentPrefix: 'node-relay',
    protocols: Object.freeze(['http:', 'https:', 'ws:', 'wss:']),
    valueFlags: Object.freeze([
      '--node-id',
      '--id',
      '--heartbeat-ms',
      '--connect-timeout-ms',
      '--reconnect-delay-ms'
    ]),
    booleanFlags: Object.freeze([])
  }),
  Object.freeze({
    labelPrefix: 'com.clawdcodex.ai_home.fabric-registry-agent.',
    command: Object.freeze(['fabric', 'registry', 'agent']),
    componentPrefix: 'fabric-registry-agent',
    protocols: Object.freeze(['http:', 'https:']),
    valueFlags: Object.freeze([
      '--node-id',
      '--status',
      '--relay-status',
      '--transport',
      '--probe-transport',
      '--probe-timeout-ms',
      '--probe-method',
      '--probe-count',
      '--probe-payload-size',
      '--interval-ms'
    ]),
    booleanFlags: Object.freeze(['--runtime-diagnostics'])
  }),
  Object.freeze({
    labelPrefix: 'com.clawdcodex.ai_home.node-webrtc.',
    command: Object.freeze(['node', 'webrtc', 'connect']),
    componentPrefix: 'node-webrtc',
    protocols: Object.freeze(['http:', 'https:', 'ws:', 'wss:']),
    valueFlags: Object.freeze([
      '--node-id',
      '--id',
      '--connect-timeout-ms',
      '--reconnect-delay-ms'
    ]),
    booleanFlags: Object.freeze([])
  })
]);

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function decodeCodePoint(match, raw, radix) {
  const value = Number.parseInt(raw, radix);
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return match;
  try {
    return String.fromCodePoint(value);
  } catch (_error) {
    return match;
  }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (match, raw) => decodeCodePoint(match, raw, 16))
    .replace(/&#([0-9]+);/g, (match, raw) => decodeCodePoint(match, raw, 10))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractPlistString(content, key) {
  const pattern = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`, 'i');
  const match = String(content || '').match(pattern);
  return match ? decodeXml(match[1]).trim() : '';
}

function extractProgramArguments(content) {
  const match = String(content || '').match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i
  );
  if (!match) return [];
  const argumentsList = [];
  const stringPattern = /<string>([\s\S]*?)<\/string>/gi;
  let stringMatch = stringPattern.exec(match[1]);
  while (stringMatch) {
    argumentsList.push(decodeXml(stringMatch[1]));
    stringMatch = stringPattern.exec(match[1]);
  }
  return argumentsList;
}

function migrationError(code, file, label) {
  const error = new Error(`${code}:${label || file}`);
  error.code = code;
  error.file = file;
  error.label = label;
  return error;
}

function splitFlag(value) {
  const text = String(value || '');
  const separator = text.indexOf('=');
  if (separator < 0) return { name: text, inlineValue: null };
  return {
    name: text.slice(0, separator),
    inlineValue: text.slice(separator + 1)
  };
}

function normalizeNodeId(value) {
  const normalized = nonEmptyString(value).toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(normalized) ? normalized : '';
}

function serviceLabelSuffix(nodeId) {
  return normalizeNodeId(nodeId)
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateControlUrl(value, descriptor, file, label) {
  let parsed;
  try {
    parsed = new URL(nonEmptyString(value));
  } catch (_error) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
  if (!descriptor.protocols.includes(parsed.protocol)) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
}

function sanitizePersistentFlagValue(descriptor, flag, value, file, label) {
  if (descriptor.componentPrefix !== 'fabric-registry-agent' || flag !== '--transport') {
    return String(value);
  }
  try {
    return formatPersistentTransportHeartbeat(parseTransportHeartbeat(value));
  } catch (_error) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
}

function parseComponent(programArguments, descriptor, file, label) {
  if (hasSecretBearingArgument(programArguments.slice(1))) {
    throw migrationError('legacy_macos_service_secret_args', file, label);
  }
  if (programArguments.length < 6) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
  const args = programArguments.slice(1);
  const sanitizedArgs = args.slice();
  if (!descriptor.command.every((token, index) => args[index] === token)) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
  const commandArgs = args.slice(descriptor.command.length);
  const controlUrl = nonEmptyString(commandArgs[0]);
  if (!controlUrl || controlUrl.startsWith('-')) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
  validateControlUrl(controlUrl, descriptor, file, label);

  const valueFlags = new Set(descriptor.valueFlags);
  const booleanFlags = new Set(descriptor.booleanFlags);
  let nodeId = '';
  for (let index = 1; index < commandArgs.length;) {
    const token = String(commandArgs[index] || '');
    if (!token.startsWith('--')) {
      throw migrationError('legacy_macos_service_invalid_plist', file, label);
    }
    const parsedFlag = splitFlag(token);
    if (booleanFlags.has(parsedFlag.name)) {
      if (parsedFlag.inlineValue !== null) {
        throw migrationError('legacy_macos_service_invalid_plist', file, label);
      }
      index += 1;
      continue;
    }
    if (!valueFlags.has(parsedFlag.name)) {
      throw migrationError('legacy_macos_service_invalid_plist', file, label);
    }
    const value = parsedFlag.inlineValue === null
      ? commandArgs[index + 1]
      : parsedFlag.inlineValue;
    if (value === undefined || value === '' || (parsedFlag.inlineValue === null && String(value).startsWith('--'))) {
      throw migrationError('legacy_macos_service_invalid_plist', file, label);
    }
    const sanitizedValue = sanitizePersistentFlagValue(
      descriptor,
      parsedFlag.name,
      value,
      file,
      label
    );
    const absoluteIndex = descriptor.command.length + index;
    if (parsedFlag.inlineValue === null) {
      sanitizedArgs[absoluteIndex + 1] = sanitizedValue;
    } else {
      sanitizedArgs[absoluteIndex] = `${parsedFlag.name}=${sanitizedValue}`;
    }
    if (parsedFlag.name === '--node-id' || parsedFlag.name === '--id') {
      const candidate = normalizeNodeId(value);
      if (!candidate || nodeId) {
        throw migrationError('legacy_macos_service_invalid_plist', file, label);
      }
      nodeId = candidate;
    }
    index += parsedFlag.inlineValue === null ? 2 : 1;
  }

  if (!nodeId || label !== `${descriptor.labelPrefix}${serviceLabelSuffix(nodeId)}`) {
    throw migrationError('legacy_macos_service_invalid_plist', file, label);
  }
  return {
    id: `${descriptor.componentPrefix}:${nodeId}`,
    args: sanitizedArgs
  };
}

function descriptorForLabel(label) {
  return LEGACY_SERVICE_TYPES.find((descriptor) => label.startsWith(descriptor.labelPrefix)) || null;
}

function scanLegacyMacosServices(options = {}, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const launchAgentsDir = nonEmptyString(options.launchAgentsDir);
  if (!launchAgentsDir || !fs.existsSync(launchAgentsDir)) {
    return { components: [], legacyServices: [] };
  }

  const components = [];
  const legacyServices = [];
  const componentIds = new Set();
  const files = fs.readdirSync(launchAgentsDir)
    .map((name) => String(name))
    .filter((name) => name.endsWith('.plist'))
    .sort();

  for (const name of files) {
    const fileLabel = name.slice(0, -'.plist'.length);
    const descriptor = descriptorForLabel(fileLabel);
    if (!descriptor) continue;
    const file = path.join(launchAgentsDir, name);
    let content;
    try {
      if (!fs.statSync(file).isFile()) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch (_error) {
      throw migrationError('legacy_macos_service_invalid_plist', file, fileLabel);
    }
    const label = extractPlistString(content, 'Label');
    if (label !== fileLabel) {
      throw migrationError('legacy_macos_service_invalid_plist', file, label || fileLabel);
    }
    const component = parseComponent(extractProgramArguments(content), descriptor, file, label);
    if (componentIds.has(component.id)) {
      throw migrationError('legacy_macos_service_duplicate_component', file, label);
    }
    componentIds.add(component.id);
    components.push(component);
    legacyServices.push({ label, file });
  }

  return { components, legacyServices };
}

module.exports = {
  scanLegacyMacosServices
};
