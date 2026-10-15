'use strict';

const { requiredString } = require('../cores/mihomo/proxy-fields');
const { protocolFieldError } = require('../protocol-fields');
const { optionalString } = require('../protocol-parsers/clash-fields');
const { firstPortOf, formatPortRanges, normalizePortRanges } = require('../port-range');

// mieru 的取值集合都是大写枚举（mihomo 文档）。
const TRANSPORTS = Object.freeze(new Set(['TCP', 'UDP']));
const MULTIPLEXING = Object.freeze(new Set(['MULTIPLEXING_OFF', 'MULTIPLEXING_LOW', 'MULTIPLEXING_MIDDLE', 'MULTIPLEXING_HIGH']));
const HANDSHAKES = Object.freeze(new Set(['HANDSHAKE_STANDARD', 'HANDSHAKE_NO_WAIT']));

function upper(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text || undefined;
}

function enumOf(value, allowed, field) {
  const text = upper(value);
  if (text === undefined) return undefined;
  if (!allowed.has(text)) throw protocolFieldError(`invalid_proxy_field_${field}`);
  return text;
}

// 客户端只给了端口范围、没给单端口时，用范围里的第一个端口补上 port（各格式都要求 port）。
function portWithFallback(port, ports) {
  if (Number.isFinite(Number(port)) && Number(port) > 0) return undefined;
  return firstPortOf(ports);
}

/**
 * Mieru：只有 mihomo 有出站（sing-box 没有实现）。没有公认的分享链接格式
 * （`mierus://` 各家只用来做兼容性判断，不做逐字段解析），只从配置导入。
 */
module.exports = Object.freeze({
  id: 'mieru',
  capability: 'proxy-pool.protocol',
  name: 'Mieru',
  protocols: Object.freeze(['mieru']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze([]),
  fields: Object.freeze({
    username: 'string',
    password: 'string',
    transport: 'string',
    multiplexing: 'string',
    handshakeMode: 'string',
    trafficPattern: 'string',
    // 端口范围（mihomo 的 port-range）；与 port 互斥，port 取范围里的第一个端口。
    ports: 'port-range'
  }),
  required: Object.freeze(['username', 'password']),
  form: Object.freeze({
    options: Object.freeze({
      transport: Object.freeze(['TCP', 'UDP']),
      multiplexing: Object.freeze(['MULTIPLEXING_OFF', 'MULTIPLEXING_LOW', 'MULTIPLEXING_MIDDLE', 'MULTIPLEXING_HIGH']),
      handshakeMode: Object.freeze(['HANDSHAKE_STANDARD', 'HANDSHAKE_NO_WAIT'])
    })
  }),
  validate(node) {
    enumOf(node.transport, TRANSPORTS, 'transport');
    enumOf(node.multiplexing, MULTIPLEXING, 'multiplexing');
    enumOf(node.handshakeMode, HANDSHAKES, 'handshakeMode');
  },
  // 三个字段都是大写枚举：写法大小写不同（tcp / TCP）应视为同一连接。
  connectionIdentity: (node) => ({
    transport: upper(node.transport),
    multiplexing: upper(node.multiplexing),
    handshakeMode: upper(node.handshakeMode)
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['mieru']),
      parse(proxy) {
        const ports = normalizePortRanges(proxy['port-range']);
        const fallbackPort = portWithFallback(proxy.port, ports);
        return {
          username: optionalString(proxy.username),
          password: optionalString(proxy.password),
          transport: upper(proxy.transport),
          multiplexing: upper(proxy.multiplexing),
          handshakeMode: upper(proxy['handshake-mode']),
          trafficPattern: optionalString(proxy['traffic-pattern']),
          ports,
          ...(fallbackPort ? { port: fallbackPort } : {})
        };
      }
    })
  }),
  parse: () => null,
  encode: () => '',
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'mieru';
      proxy.username = requiredString(node, 'username');
      proxy.password = requiredString(node, 'password');
      const transport = enumOf(node.transport, TRANSPORTS, 'transport');
      // mihomo 把 transport 当必填（缺了直接拒整份配置），所以宁可在这里让这个节点编不出来
      // （渲染时跳过、中转时交给别的内核），也不要输出一份会被内核拒掉的配置。
      if (!transport) throw protocolFieldError('missing_required_proxy_field_transport');
      proxy.transport = transport;
      const multiplexing = enumOf(node.multiplexing, MULTIPLEXING, 'multiplexing');
      if (multiplexing) proxy.multiplexing = multiplexing;
      const handshake = enumOf(node.handshakeMode, HANDSHAKES, 'handshakeMode');
      if (handshake) proxy['handshake-mode'] = handshake;
      if (node.trafficPattern) proxy['traffic-pattern'] = String(node.trafficPattern);
      const ports = formatPortRanges(node.ports);
      if (ports) {
        // mihomo 的 port 与 port-range 不能同时写。
        delete proxy.port;
        proxy['port-range'] = ports;
      }
      return proxy;
    }
  })
});
