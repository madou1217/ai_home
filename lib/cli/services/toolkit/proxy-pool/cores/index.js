'use strict';

const mihomo = require('./mihomo');

/**
 * 代理内核插件注册表。当前只有 Mihomo；新增内核（如 sing-box）= 新增 cores/<id>/ 插件并登记，
 * 同时在各协议插件里补上 compile[<id>]。
 */
const PROXY_CORE_PLUGINS = Object.freeze([mihomo]);
const DEFAULT_PROXY_CORE_ID = 'mihomo';

const CORE_BY_ID = new Map(PROXY_CORE_PLUGINS.map((core) => [core.id, core]));

function getProxyCore(id = DEFAULT_PROXY_CORE_ID) {
  return CORE_BY_ID.get(String(id || DEFAULT_PROXY_CORE_ID).trim().toLowerCase()) || null;
}

module.exports = {
  DEFAULT_PROXY_CORE_ID,
  PROXY_CORE_PLUGINS,
  getProxyCore
};
