'use strict';

const crypto = require('node:crypto');

/**
 * 「跟随 AIH 端口」模式下的 SOCKS5 用户名：一个节点一个用户名，客户端靠它在同一个端口上选出节点。
 *
 * 为什么用用户名选节点：所有节点共用一个端口（就是 AIH 自己的端口），端口号无法再区分节点，
 * 而 SOCKS5 认证里的用户名是每个代理条目自己的 —— 客户端每个条目会单独建连并带自己的用户名，
 * 所以「用户名 = 节点」是唯一不需要额外端口的表达方式（见 relay-port-mux）。
 *
 * 用户名必须**稳定**（客户端配置会缓存它）且**合法**（SOCKS5 用户名是 1..255 字节的裸字节，
 * 不能有控制字符/冒号之类的歧义）：用节点 id 的 sha1 前 12 位十六进制，配 `n` 前缀。
 * 节点 id 是稳定的，所以重启/重新拉订阅后用户名不变。
 */

const USER_PREFIX = 'n';

function userNameForNode(nodeId) {
  const digest = crypto.createHash('sha1').update(String(nodeId || '')).digest('hex');
  return `${USER_PREFIX}${digest.slice(0, 12)}`;
}

module.exports = {
  USER_PREFIX,
  userNameForNode
};
