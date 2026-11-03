'use strict';

// Surge / Surfboard / Loon 配置（或只有代理行的列表）→ 节点：读 [Proxy] 段，没有分段时读全部行。
// 同一类型在 Surge 与 Loon 里位置参数不同（Loon 把凭据写在第三个位置参数），按行判断格式后
// 交给认领该类型的协议插件（imports.surge / imports.loon）。WireGuard 的地址不在代理行上：
// Surge / Surfboard 写在 `[WireGuard <section-name>]` 段里，Loon 写在内联的 peers=[{…}]。

const { buildImportedNode, importError } = require('./imported-node');
const { parseSurgeLine } = require('./surge-line');

// 不是代理的内置策略（Surge 的 [Proxy] 里可以写 `On = direct`）。
const BUILTIN_TYPES = new Set(['direct', 'reject', 'reject-tinygif', 'reject-drop', 'reject-no-drop']);
const LOON_ONLY_TYPES = new Set(['shadowsocks', 'shadowsocksr', 'vless']);
// 这些类型 Surge 用命名参数放凭据，Loon 用第三个位置参数（AnyTLS 也一样：Surge 写 password=，
// Loon 写 "密码"）。
const SURGE_CREDENTIAL_PARAMS = Object.freeze({ anytls: 'password', vmess: 'username', trojan: 'password', hysteria2: 'password' });
// 同一个类型在 Surge / Surfboard 与 Loon 里写法完全不同时，靠这个参数区分（Loon 的 WireGuard 内联对端）。
const LOON_INLINE_PARAMS = Object.freeze({ wireguard: 'peers' });

function findPlugin(format, type) {
  return require('../protocols').findProtocolPluginForImport(format, type);
}

function lineFormat(line) {
  if (LOON_ONLY_TYPES.has(line.type)) return 'loon';
  const inline = LOON_INLINE_PARAMS[line.type];
  if (inline && line.params[inline] !== undefined) return 'loon';
  const credential = SURGE_CREDENTIAL_PARAMS[line.type];
  if (credential && line.params[credential] === undefined && line.args.length >= 3) return 'loon';
  return 'surge';
}

function proxyLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hasProxySection = lines.some((line) => /^\s*\[proxy\]\s*$/i.test(line));
  let section = '';
  return lines.filter((line) => {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      return false;
    }
    // 有 [Proxy] 段时只读它；没有（节点视图：代理行 + [WireGuard x] 段）时读段头之前的所有行。
    return hasProxySection ? section === 'proxy' : section === '';
  });
}

/** `[WireGuard <name>]` 段的正文：段名 → `key = value` 字段表。 */
function wireguardSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      const match = header[1].trim().match(/^wireguard\s+(.+)$/i);
      current = match ? match[1].trim().toLowerCase() : null;
      if (current) sections.set(current, []);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*([A-Za-z0-9-]+)\s*=\s*([\s\S]*?)\s*$/);
    if (field) sections.get(current).push({ key: field[1].toLowerCase(), value: field[2] });
  }
  const fields = new Map();
  for (const [name, entries] of sections) {
    fields.set(name, Object.fromEntries(entries.map((entry) => [entry.key, entry.value])));
  }
  return fields;
}

function sectionFor(line, sections) {
  const name = String(line.params['section-name'] || '').trim().toLowerCase();
  return name ? sections.get(name) : undefined;
}

function convertLine(line, sections) {
  const format = lineFormat(line);
  const plugin = findPlugin(format, line.type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${line.type}`);
  const fields = plugin.imports[format].parse({ ...line, sections: sectionFor(line, sections) });
  return buildImportedNode({
    plugin,
    name: line.name,
    // WireGuard 的服务器与端口在段 / 内联对端里，插件从 fields 带出来；其余格式取位置参数。
    server: fields.server ?? line.args[0],
    port: fields.port ?? line.args[1],
    fields
  });
}

function parseSurgeProxiesDetailed(text) {
  const nodes = [];
  const skippedNodes = [];
  const sections = wireguardSections(text);
  for (const raw of proxyLines(text)) {
    const line = parseSurgeLine(raw);
    if (!line || BUILTIN_TYPES.has(line.type)) continue;
    try {
      nodes.push(convertLine(line, sections));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: line.name, reason: error.code || error.message });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

/**
 * 有 [Proxy] 段，或至少一行形如 `名字 = 类型, 服务器, 端口`，或带 [WireGuard x] 段（节点视图里
 * WireGuard 的地址全在段里，代理行上看不出服务器）。sectionsOnly 时只认分段标记（正文里有逐行
 * 分享链接时，不按宽松的行格式猜）。
 */
function looksLikeSurgeConfig(text, { sectionsOnly = false } = {}) {
  if (/^\s*\[Proxy\]\s*$/mi.test(text)) return true;
  if (/^\s*\[WireGuard\s+[^\]]+\]\s*$/mi.test(text)) return true;
  return !sectionsOnly && /^[^=\r\n#;]+=\s*[A-Za-z0-9-]+\s*,\s*[^,\s]+\s*,\s*\d{1,5}\s*(?:,|$)/m.test(text);
}

module.exports = {
  looksLikeSurgeConfig,
  parseSurgeProxiesDetailed
};
