'use strict';

// Surge / Surfboard / Loon 配置（或只有代理行的列表）→ 节点：读 [Proxy] 段，没有分段时读全部行。
// 同一类型在 Surge 与 Loon 里位置参数不同（Loon 把凭据写在第三个位置参数），按行判断格式后
// 交给认领该类型的协议插件（imports.surge / imports.loon）。

const { buildImportedNode, importError } = require('./imported-node');
const { parseSurgeLine } = require('./surge-line');

// 不是代理的内置策略（Surge 的 [Proxy] 里可以写 `On = direct`）。
const BUILTIN_TYPES = new Set(['direct', 'reject', 'reject-tinygif', 'reject-drop', 'reject-no-drop']);
const LOON_ONLY_TYPES = new Set(['shadowsocks', 'shadowsocksr', 'vless']);
// 这些类型 Surge 用命名参数放凭据，Loon 用第三个位置参数。
const SURGE_CREDENTIAL_PARAMS = Object.freeze({ vmess: 'username', trojan: 'password', hysteria2: 'password' });

function findPlugin(format, type) {
  return require('../protocols').findProtocolPluginForImport(format, type);
}

function lineFormat(line) {
  if (LOON_ONLY_TYPES.has(line.type)) return 'loon';
  const credential = SURGE_CREDENTIAL_PARAMS[line.type];
  if (credential && line.params[credential] === undefined && line.args.length >= 3) return 'loon';
  return 'surge';
}

function proxyLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hasSections = lines.some((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  let section = '';
  return lines.filter((line) => {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      return false;
    }
    return !hasSections || section === 'proxy';
  });
}

function convertLine(line) {
  const format = lineFormat(line);
  const plugin = findPlugin(format, line.type);
  if (!plugin) throw importError(`unsupported_proxy_protocol_${line.type}`);
  return buildImportedNode({
    plugin,
    name: line.name,
    server: line.args[0],
    port: line.args[1],
    fields: plugin.imports[format].parse(line)
  });
}

function parseSurgeProxiesDetailed(text) {
  const nodes = [];
  const skippedNodes = [];
  for (const raw of proxyLines(text)) {
    const line = parseSurgeLine(raw);
    if (!line || BUILTIN_TYPES.has(line.type)) continue;
    try {
      nodes.push(convertLine(line));
    } catch (error) {
      skippedNodes.push({ nodeId: null, name: line.name, reason: error.code || error.message });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

/**
 * 有 [Proxy] 段，或至少一行形如 `名字 = 类型, 服务器, 端口`。sectionsOnly 时只认分段标记
 * （正文里有逐行分享链接时，不按宽松的行格式猜）。
 */
function looksLikeSurgeConfig(text, { sectionsOnly = false } = {}) {
  if (/^\s*\[Proxy\]\s*$/mi.test(text)) return true;
  return !sectionsOnly && /^[^=\r\n#;]+=\s*[A-Za-z0-9-]+\s*,\s*[^,\s]+\s*,\s*\d{1,5}\s*(?:,|$)/m.test(text);
}

module.exports = {
  looksLikeSurgeConfig,
  parseSurgeProxiesDetailed
};
