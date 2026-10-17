'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');

const { readEdgeContextField } = require('../edge-context');

/**
 * 本机转发（frp）provider：读/写 frpc 的 TOML 配置、校验、重启服务。
 *
 * 为什么需要它：AIH 部署在 NAT 后面时，手机/公网要连的「那个端口」通常是 frp 转发出来的
 * （本机 9527 → 远端 29527）。这份能力让「加一条转发」变成一条本机命令，而不是去手改 TOML
 * 再自己重启服务（改坏了 SSH 端口转发会把用户自己关在门外）。
 *
 * 硬约束：
 * - 只动 `[[proxies]]` 里由 AIH 管理的条目（`# aih-managed:<name>` 标记），用户其它转发原样保留；
 * - 写入前备份、写入后**必须校验通过**才重启（`frpc verify -c`），校验失败回滚，绝不留坏配置；
 * - 不猜服务管理方式：brew services / systemd(user) / 直接进程，探测到哪种用哪种，都没有就只写文件并提示。
 */

const MARKER_PREFIX = '# aih-managed:';

const CONFIG_CANDIDATES = Object.freeze([
  '/opt/homebrew/etc/frp/frpc.toml',
  '/usr/local/etc/frp/frpc.toml',
  '/etc/frp/frpc.toml',
  '/etc/frp/frpc.ini'
]);

function candidateBinaries(env = {}) {
  return [
    env.AIH_EDGE_FRPC_BIN,
    '/opt/homebrew/bin/frpc',
    '/usr/local/bin/frpc',
    '/usr/bin/frpc'
  ].filter(Boolean);
}

function isExecutable(fsImpl, file) {
  try {
    fsImpl.accessSync(file, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveBinary({ fs: fsImpl = nativeFs, env = {} } = {}) {
  for (const candidate of candidateBinaries(env)) {
    if (isExecutable(fsImpl, candidate)) return candidate;
  }
  return '';
}

function resolveConfigPath({ fs: fsImpl = nativeFs, env = {} } = {}) {
  const explicit = String(readEdgeContextField(env, 'frpcConfig')).trim();
  if (explicit) return explicit;
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch (_error) { /* 忽略 */ }
  }
  return '';
}

/** 解析出全部 [[proxies]] 块（含块前的 marker 注释，用于识别 AIH 自己写的条目）。 */
function parseProxies(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = null;
  let pendingMarker = false;
  lines.forEach((line, index) => {
    if (/^\s*\[\[proxies\]\]\s*$/.test(line)) {
      if (current) blocks.push(current);
      // marker 写在块**之前**：它描述的是接下来这一块，不能算到上一块头上。
      current = { startLine: index, endLine: index, fields: {}, managed: pendingMarker };
      pendingMarker = false;
      return;
    }
    if (/^\s*#\s*aih-managed:/.test(line)) {
      pendingMarker = true;
      if (current) current.endLine = index;
      return;
    }
    if (!current) return;
    if (/^\s*\[/.test(line)) {
      blocks.push(current);
      current = null;
      return;
    }
    const match = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) current.fields[match[1]] = match[2].replace(/^"|"$/g, '');
    current.endLine = index;
  });
  if (current) blocks.push(current);
  return blocks;
}

function listProxies(text) {
  return parseProxies(text).map((block) => ({
    name: block.fields.name || '',
    type: block.fields.type || '',
    localIP: block.fields.localIP || '',
    localPort: Number(block.fields.localPort || 0),
    remotePort: Number(block.fields.remotePort || 0),
    managed: block.managed
  }));
}

function renderProxy({ name, type, localIP = '127.0.0.1', localPort, remotePort }) {
  return [
    `${MARKER_PREFIX}${name}`,
    '[[proxies]]',
    `name = "${name}"`,
    `type = "${type}"`,
    `localIP = "${localIP}"`,
    `localPort = ${Number(localPort)}`,
    `remotePort = ${Number(remotePort)}`,
    ''
  ].join('\n');
}

/** 删掉同名/同类型 AIH 条目（只删带标记的，用户手写的同名条目不动）。 */
function removeProxy(text, name) {
  const lines = String(text || '').split('\n');
  const blocks = parseProxies(text);
  const drop = new Set();
  for (const block of blocks) {
    if (!block.managed || block.fields.name !== name) continue;
    for (let index = block.startLine; index <= block.endLine; index += 1) drop.add(index);
    // 连带其后的空行
    let cursor = block.endLine + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') drop.add(cursor++);
  }
  return lines.filter((_line, index) => !drop.has(index)).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 写入一条转发（同名旧条目先删），保持用户其它配置原样。 */
function upsertProxy(text, proxy) {
  const base = removeProxy(text, proxy.name).replace(/\s*$/, '\n');
  return `${base}\n${renderProxy(proxy)}`;
}

module.exports = {
  CONFIG_CANDIDATES,
  MARKER_PREFIX,
  listProxies,
  parseProxies,
  removeProxy,
  renderProxy,
  resolveBinary,
  resolveConfigPath,
  upsertProxy
};
