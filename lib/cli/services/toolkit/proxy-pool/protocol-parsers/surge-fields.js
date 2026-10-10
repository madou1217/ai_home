'use strict';

// Surge 系代理行参数 → 节点字段（供各协议插件的 imports.surge 复用），与 cores/surge 的编译对称。

const { optionalString } = require('./clash-fields');

function flag(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? '').trim());
}

function surgeTlsFields(params, options = {}) {
  return {
    tls: options.forceTls === true || flag(params.tls) || undefined,
    sni: optionalString(params.sni ?? params['tls-name']),
    allowInsecure: flag(params['skip-cert-verify']) || undefined
  };
}

function wsHost(headers) {
  const entry = String(headers || '').split('|').map((item) => item.trim())
    .find((item) => /^host\s*:/i.test(item));
  return entry ? optionalString(entry.slice(entry.indexOf(':') + 1).trim()) : undefined;
}

function surgeTransportFields(params) {
  if (!flag(params.ws)) return { network: 'tcp' };
  return { network: 'ws', path: optionalString(params['ws-path']), host: wsHost(params['ws-headers']) };
}

/** simple-obfs 参数 → 节点的 SS 插件字段（固定顺序，往返后字符串一致）。 */
function surgeObfsFields(params) {
  const mode = optionalString(params.obfs);
  if (!mode) return {};
  const options = [`obfs=${mode}`];
  if (params['obfs-host']) options.push(`obfs-host=${params['obfs-host']}`);
  if (params['obfs-uri']) options.push(`obfs-uri=${params['obfs-uri']}`);
  return { plugin: 'obfs-local', pluginOpts: options.join(';') };
}

function loonTlsFields(params, options = {}) {
  return {
    tls: options.forceTls === true || flag(params['over-tls']) || undefined,
    sni: optionalString(params.sni ?? params['tls-name']),
    allowInsecure: flag(params['skip-cert-verify']) || undefined
  };
}

function loonTransportFields(params) {
  const network = String(params.transport || 'tcp').trim().toLowerCase() || 'tcp';
  if (network === 'tcp') return { network };
  return { network, path: optionalString(params.path), host: optionalString(params.host) };
}

/** Loon 的 obfs-name / obfs-host / obfs-uri → SS 插件字段（与 Surge 的 simple-obfs 同一表示）。 */
function loonObfsFields(params) {
  return surgeObfsFields({ obfs: params['obfs-name'], 'obfs-host': params['obfs-host'], 'obfs-uri': params['obfs-uri'] });
}

module.exports = {
  flag,
  loonObfsFields,
  loonTlsFields,
  loonTransportFields,
  surgeObfsFields,
  surgeTlsFields,
  surgeTransportFields,
  wsHost
};
