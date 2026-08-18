'use strict';

const { inferCountryCode } = require('./base-parser');

function yamlParseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function scanTopLevel(text, onSeparator) {
  let quote = null;
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === '\\') {
        escaped = true;
      } else if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    if (braces < 0 || brackets < 0) throw yamlParseError('invalid_clash_yaml_flow_collection');
    if (braces === 0 && brackets === 0 && onSeparator(char, index)) return index;
  }
  if (quote || braces !== 0 || brackets !== 0) throw yamlParseError('invalid_clash_yaml_flow_collection');
  return -1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let rest = text;
  while (rest.length) {
    const index = scanTopLevel(rest, (char) => char === separator);
    if (index === -1) break;
    parts.push(rest.slice(0, index));
    start += index + 1;
    rest = text.slice(start);
  }
  parts.push(rest);
  return parts;
}

function stripPlainComment(value) {
  const index = value.search(/\s+#/);
  return (index === -1 ? value : value.slice(0, index)).trimEnd();
}

function parseYamlScalar(rawValue) {
  const value = String(rawValue).trim();
  if (value === '') return '';
  if (value.startsWith('{')) return parseFlowMap(value);
  if (value.startsWith('[')) return parseFlowArray(value);
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw yamlParseError('invalid_clash_yaml_quoted_scalar');
    try {
      return JSON.parse(value);
    } catch (_error) {
      throw yamlParseError('invalid_clash_yaml_quoted_scalar');
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw yamlParseError('invalid_clash_yaml_quoted_scalar');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^[&*]|^!\S|^[>|]$/.test(value)) throw yamlParseError('unsupported_clash_yaml_scalar');
  return stripPlainComment(value);
}

function findMappingColon(text) {
  return scanTopLevel(text, (char) => char === ':');
}

function parseMappingEntry(text) {
  const colon = findMappingColon(text);
  if (colon <= 0) throw yamlParseError('invalid_clash_yaml_mapping');
  const rawKey = text.slice(0, colon).trim();
  const key = rawKey.startsWith('"') || rawKey.startsWith("'")
    ? parseYamlScalar(rawKey)
    : rawKey;
  if (typeof key !== 'string' || !key || key === '<<') throw yamlParseError('unsupported_clash_yaml_mapping_key');
  return { key, rawValue: text.slice(colon + 1).trim() };
}

function assignUnique(target, key, value) {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) {
    throw yamlParseError('unsupported_clash_yaml_mapping_key');
  }
  if (Object.prototype.hasOwnProperty.call(target, key)) throw yamlParseError(`duplicate_clash_yaml_key_${key}`);
  target[key] = value;
}

function parseFlowMap(text) {
  if (!text.endsWith('}')) throw yamlParseError('invalid_clash_yaml_flow_map');
  const body = text.slice(1, -1).trim();
  if (!body) return {};
  const result = {};
  for (const part of splitTopLevel(body, ',')) {
    const { key, rawValue } = parseMappingEntry(part);
    if (!rawValue) throw yamlParseError(`invalid_clash_yaml_value_${key}`);
    assignUnique(result, key, parseYamlScalar(rawValue));
  }
  return result;
}

function parseFlowArray(text) {
  if (!text.endsWith(']')) throw yamlParseError('invalid_clash_yaml_flow_array');
  const body = text.slice(1, -1).trim();
  if (!body) return [];
  return splitTopLevel(body, ',').map((item) => parseYamlScalar(item));
}

function leadingSpaces(line) {
  if (line.includes('\t')) throw yamlParseError('tabs_not_allowed_in_clash_yaml');
  return line.length - line.trimStart().length;
}

function parseProxyMaps(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let sectionIndex = -1;
  let sectionIndent = 0;
  let inlineValue = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue;
    const match = trimmed.match(/^proxies\s*:(.*)$/);
    if (match && indent === 0) {
      sectionIndex = index;
      sectionIndent = indent;
      inlineValue = match[1].trim();
      break;
    }
  }
  if (sectionIndex === -1) return [];
  if (inlineValue) {
    const inline = parseYamlScalar(inlineValue);
    if (!Array.isArray(inline) || inline.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw yamlParseError('invalid_clash_yaml_proxies');
    }
    return inline;
  }

  const items = [];
  let current = null;
  let itemIndent = null;
  let stack = [];
  const finishCurrent = () => {
    if (current) items.push(current);
    current = null;
    stack = [];
  };

  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = leadingSpaces(line);
    if (indent <= sectionIndent) break;
    if (trimmed.startsWith('-')) {
      if (itemIndent === null) itemIndent = indent;
      if (indent !== itemIndent) throw yamlParseError('unsupported_clash_yaml_block_sequence');
      finishCurrent();
      const rest = trimmed.slice(1).trim();
      if (rest.startsWith('{')) {
        current = parseFlowMap(rest);
        stack = [{ indent: itemIndent, value: current }];
        continue;
      }
      current = {};
      stack = [{ indent: itemIndent, value: current }];
      if (rest) {
        const { key, rawValue } = parseMappingEntry(rest);
        if (rawValue) assignUnique(current, key, parseYamlScalar(rawValue));
        else {
          const child = {};
          assignUnique(current, key, child);
          stack.push({ indent: itemIndent + 1, value: child });
        }
      }
      continue;
    }
    if (!current || itemIndent === null || indent <= itemIndent) {
      throw yamlParseError('invalid_clash_yaml_proxy_item');
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.value;
    if (!parent) throw yamlParseError('invalid_clash_yaml_indentation');
    const { key, rawValue } = parseMappingEntry(trimmed);
    if (rawValue) {
      assignUnique(parent, key, parseYamlScalar(rawValue));
    } else {
      const child = {};
      assignUnique(parent, key, child);
      stack.push({ indent, value: child });
    }
  }
  finishCurrent();
  return items;
}

function numericRate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function tlsEnabled(value) {
  return value === true || /^(?:true|tls)$/i.test(String(value || ''));
}

// 机场订阅普遍会带的传输开关：它们既不改变出站目标，也不参与我们编译出的配置
// （mihomo-config-compiler 只按 node 字段自行拼 proxy），所以只忽略、不拒绝。
//
// 这里必须显式列白：早期版本把「未知字段」一律判为不支持，导致带 `udp: true` 的
// clash 订阅整份被丢空（0 节点），随后应用空配置又连带报 routing_not_fully_applied /
// proxy_core_rollback_not_applied，看上去像核心坏了，其实是解析阶段就没节点。
// 新增条目请守住同一条标准：不影响出站身份与目标，否则应该走 fields 白名单。
const IGNORED_PROXY_FIELDS = [
  'udp',
  'udp-over-tcp',
  'tfo',
  'fast-open',
  'mptcp',
  'ip-version'
];

function validateKnownFields(proxy, type) {
  const common = ['name', 'type', 'server', 'port', ...IGNORED_PROXY_FIELDS];
  const fields = {
    ss: ['cipher', 'password', 'plugin', 'plugin-opts'],
    shadowsocks: ['cipher', 'password', 'plugin', 'plugin-opts'],
    vmess: ['uuid', 'alterId', 'alter-id', 'cipher', 'network', 'tls', 'servername', 'sni', 'skip-cert-verify', 'ws-opts', 'grpc-opts', 'alpn'],
    vless: ['uuid', 'flow', 'network', 'tls', 'servername', 'sni', 'skip-cert-verify', 'ws-opts', 'grpc-opts', 'alpn', 'reality-opts', 'client-fingerprint'],
    trojan: ['password', 'network', 'tls', 'servername', 'sni', 'skip-cert-verify', 'ws-opts', 'grpc-opts', 'alpn'],
    hysteria2: ['password', 'sni', 'skip-cert-verify', 'obfs', 'obfs-password', 'up', 'down'],
    hy2: ['password', 'sni', 'skip-cert-verify', 'obfs', 'obfs-password', 'up', 'down'],
    socks5: ['username', 'password'],
    http: ['username', 'password', 'tls', 'sni', 'skip-cert-verify'],
    https: ['username', 'password', 'tls', 'sni', 'skip-cert-verify']
  };
  const allowed = new Set(common.concat(fields[type] || []));
  const unknown = Object.keys(proxy).find((key) => !allowed.has(key));
  return unknown ? `unsupported_proxy_field_${unknown}` : null;
}

function transportFields(proxy, node) {
  node.network = String(proxy.network || 'tcp').toLowerCase();
  const wsOptions = proxy['ws-opts'];
  if (wsOptions !== undefined) {
    if (!wsOptions || typeof wsOptions !== 'object' || Array.isArray(wsOptions)) throw yamlParseError('invalid_proxy_field_ws-opts');
    const unknown = Object.keys(wsOptions).find((key) => !['path', 'headers'].includes(key));
    if (unknown) throw yamlParseError(`unsupported_proxy_field_ws-opts.${unknown}`);
    node.path = wsOptions.path === undefined ? undefined : String(wsOptions.path);
    if (wsOptions.headers !== undefined) {
      if (!wsOptions.headers || typeof wsOptions.headers !== 'object' || Array.isArray(wsOptions.headers)) {
        throw yamlParseError('invalid_proxy_field_ws-opts.headers');
      }
      const headerKey = Object.keys(wsOptions.headers).find((key) => key.toLowerCase() !== 'host');
      if (headerKey) throw yamlParseError(`unsupported_proxy_field_ws-opts.headers.${headerKey}`);
      const hostEntry = Object.entries(wsOptions.headers).find(([key]) => key.toLowerCase() === 'host');
      node.host = hostEntry ? String(hostEntry[1]) : undefined;
    }
  }
  const grpcOptions = proxy['grpc-opts'];
  if (grpcOptions !== undefined) {
    if (!grpcOptions || typeof grpcOptions !== 'object' || Array.isArray(grpcOptions)) throw yamlParseError('invalid_proxy_field_grpc-opts');
    const unknown = Object.keys(grpcOptions).find((key) => key !== 'grpc-service-name');
    if (unknown) throw yamlParseError(`unsupported_proxy_field_grpc-opts.${unknown}`);
    node.serviceName = grpcOptions['grpc-service-name'] === undefined
      ? undefined
      : String(grpcOptions['grpc-service-name']);
  }
}

function convertProxy(proxy) {
  const type = String(proxy.type || '').toLowerCase();
  const protocolMap = { ss: 'shadowsocks', hy2: 'hysteria2' };
  const protocol = protocolMap[type] || type;
  const unknownField = validateKnownFields(proxy, type);
  if (unknownField) throw yamlParseError(unknownField);
  const node = {
    protocol,
    name: String(proxy.name || 'Clash Node'),
    server: typeof proxy.server === 'string' ? proxy.server : String(proxy.server || ''),
    port: Number(proxy.port)
  };
  const country = inferCountryCode(node.name, node.server);
  Object.assign(node, {
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag
  });

  if (protocol === 'shadowsocks') {
    node.cipher = proxy.cipher === undefined ? undefined : String(proxy.cipher);
    node.password = proxy.password === undefined ? undefined : String(proxy.password);
    node.plugin = proxy.plugin === undefined ? undefined : String(proxy.plugin);
    node.pluginOpts = proxy['plugin-opts'];
  } else if (protocol === 'vmess' || protocol === 'vless') {
    node.uuid = proxy.uuid === undefined ? undefined : String(proxy.uuid);
    if (protocol === 'vmess') {
      node.cipher = proxy.cipher === undefined ? undefined : String(proxy.cipher);
      node.alterId = Number(proxy.alterId ?? proxy['alter-id'] ?? 0);
    }
    node.tls = tlsEnabled(proxy.tls);
    node.sni = proxy.servername || proxy.sni || undefined;
    node.alpn = proxy.alpn;
    node.allowInsecure = Boolean(proxy['skip-cert-verify']);
    transportFields(proxy, node);
    if (protocol === 'vless') {
      node.flow = proxy.flow === undefined ? undefined : String(proxy.flow);
      const reality = proxy['reality-opts'];
      if (reality !== undefined) {
        if (!reality || typeof reality !== 'object' || Array.isArray(reality)) throw yamlParseError('invalid_proxy_field_reality-opts');
        const unknown = Object.keys(reality).find((key) => !['public-key', 'short-id'].includes(key));
        if (unknown) throw yamlParseError(`unsupported_proxy_field_reality-opts.${unknown}`);
        node.security = 'reality';
        node.publicKey = reality['public-key'] === undefined ? undefined : String(reality['public-key']);
        node.shortId = reality['short-id'] === undefined ? undefined : String(reality['short-id']);
      }
      node.fingerprint = proxy['client-fingerprint'] === undefined ? undefined : String(proxy['client-fingerprint']);
    }
  } else if (protocol === 'trojan') {
    node.password = proxy.password === undefined ? undefined : String(proxy.password);
    node.tls = true;
    node.sni = proxy.servername || proxy.sni || undefined;
    node.alpn = proxy.alpn;
    node.allowInsecure = Boolean(proxy['skip-cert-verify']);
    transportFields(proxy, node);
  } else if (protocol === 'hysteria2') {
    node.password = proxy.password === undefined ? undefined : String(proxy.password);
    node.tls = true;
    node.sni = proxy.sni === undefined ? undefined : String(proxy.sni);
    node.insecure = Boolean(proxy['skip-cert-verify']);
    node.obfs = proxy.obfs === undefined ? undefined : String(proxy.obfs);
    node.obfsPassword = proxy['obfs-password'] === undefined ? undefined : String(proxy['obfs-password']);
    node.upMbps = numericRate(proxy.up);
    node.downMbps = numericRate(proxy.down);
  } else if (['socks5', 'http', 'https'].includes(protocol)) {
    node.username = proxy.username === undefined ? undefined : String(proxy.username);
    node.password = proxy.password === undefined ? undefined : String(proxy.password);
    node.tls = protocol === 'https' || tlsEnabled(proxy.tls);
    node.sni = proxy.sni === undefined ? undefined : String(proxy.sni);
    node.allowInsecure = Boolean(proxy['skip-cert-verify']);
  }
  return node;
}

function parseClashYamlProxiesDetailed(text) {
  try {
    const proxyMaps = parseProxyMaps(text);
    const nodes = [];
    const skippedNodes = [];
    for (const proxy of proxyMaps) {
      try {
        const node = convertProxy(proxy);
        nodes.push(node);
      } catch (error) {
        skippedNodes.push({
          nodeId: null,
          name: proxy?.name ? String(proxy.name) : null,
          reason: error.code || error.message
        });
      }
    }
    return { nodes, skippedNodes, warnings: [] };
  } catch (error) {
    return {
      nodes: [],
      skippedNodes: [],
      warnings: [error.code || error.message || 'invalid_clash_yaml']
    };
  }
}

function parseClashYamlProxies(text) {
  return parseClashYamlProxiesDetailed(text).nodes;
}

module.exports = {
  convertProxy,
  parseClashYamlProxies,
  parseClashYamlProxiesDetailed,
  parseFlowArray,
  parseFlowMap,
  parseProxyMaps,
  parseYamlScalar
};
