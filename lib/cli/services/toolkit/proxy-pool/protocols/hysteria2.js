'use strict';

const { encodeHysteriaLink, parseHysteriaLink } = require('../protocol-parsers/hysteria-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { buildTls, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS } = require('../protocol-fields');
const { clashTls, numericRate, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { loonTlsParams, requiredText, surgeError, surgeTlsParams } = require('../cores/surge/proxy-fields');
const { loonTlsFields, surgeTlsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { egernTls, requiredValue } = require('../cores/egern/proxy-fields');
const { egernTlsFields } = require('../protocol-parsers/egern-fields');
const {
  firstPortOf,
  formatPortRanges,
  normalizePortRanges
} = require('../port-range');

// 客户端只给了端口列表、没给单端口时，用列表里的第一个端口补上 port（各格式都要求 port）。
function portWithFallback(port, ports) {
  if (Number.isFinite(Number(port)) && Number(port) > 0) return undefined;
  return firstPortOf(ports);
}

function hopIntervalOf(value) {
  const interval = Number(value);
  return Number.isFinite(interval) && interval > 0 ? interval : undefined;
}

// sing-box 的 hop_interval 是时长字符串（"30s" / "1m30s"），mihomo 的 hop-interval 与
// 链接里的都是秒数；两种写法都读回秒数，输出时再按各自格式写。
function parseHopInterval(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  const plain = hopIntervalOf(text);
  if (plain !== undefined) return plain;
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match) return undefined;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return seconds > 0 ? seconds : undefined;
}

module.exports = Object.freeze({
  id: 'hysteria2',
  capability: 'proxy-pool.protocol',
  name: 'Hysteria2',
  protocols: Object.freeze(['hysteria2']),
  aliases: Object.freeze(['hy2']),
  uriSchemes: Object.freeze(['hy2', 'hysteria2']),
  fields: Object.freeze({
    password: 'string',
    insecure: 'boolean',
    obfs: 'string',
    obfsPassword: 'string',
    upMbps: 'positive',
    downMbps: 'positive',
    // 端口跳跃：ports 决定连到哪些端口，计入连接身份；hopInterval 只是客户端的调优项。
    ports: 'port-range',
    hopInterval: 'count',
    ...TLS_FIELDS
  }),
  required: Object.freeze(['password']),
  clientTuning: Object.freeze(['hopInterval']),
  form: Object.freeze({
    options: Object.freeze({ obfs: Object.freeze(['salamander']) }),
    defaults: Object.freeze({ tls: true })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['hysteria2', 'hy2']),
      parse: (proxy) => {
        const ports = normalizePortRanges(proxy.ports);
        const fallbackPort = portWithFallback(proxy.port, ports);
        return {
          password: optionalString(proxy.password),
          ...clashTls(proxy, { forceTls: true }),
          obfs: optionalString(proxy.obfs),
          obfsPassword: optionalString(proxy['obfs-password']),
          upMbps: numericRate(proxy.up),
          downMbps: numericRate(proxy.down),
          ports,
          hopInterval: parseHopInterval(proxy['hop-interval']),
          ...(fallbackPort ? { port: fallbackPort } : {})
        };
      }
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse(outbound) {
        const obfs = outbound.obfs && typeof outbound.obfs === 'object' ? outbound.obfs : {};
        const ports = normalizePortRanges(outbound.server_ports);
        const fallbackPort = portWithFallback(outbound.server_port, ports);
        return {
          password: optionalString(outbound.password),
          ...singBoxTls(outbound, { forceTls: true }),
          obfs: optionalString(obfs.type),
          obfsPassword: optionalString(obfs.password),
          upMbps: numericRate(outbound.up_mbps),
          downMbps: numericRate(outbound.down_mbps),
          ports,
          hopInterval: parseHopInterval(outbound.hop_interval),
          ...(fallbackPort ? { port: fallbackPort } : {})
        };
      }
    }),
    surge: Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse: ({ args, params }) => {
        const ports = normalizePortRanges(params['port-hopping']);
        const fallbackPort = portWithFallback(args[1], ports);
        return {
          password: optionalString(params.password),
          ...surgeTlsFields(params, { forceTls: true }),
          downMbps: numericRate(params['download-bandwidth']),
          ports,
          ...(fallbackPort ? { port: fallbackPort } : {})
        };
      }
    }),
    loon: Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse: ({ args, params }) => {
        const ports = normalizePortRanges(params['server-ports']);
        const fallbackPort = portWithFallback(args[1], ports);
        return {
          password: optionalString(args[2]),
          ...loonTlsFields(params, { forceTls: true }),
          downMbps: numericRate(params['download-bandwidth']),
          ports,
          ...(fallbackPort ? { port: fallbackPort } : {}),
          ...(params['salamander-password'] ? { obfs: 'salamander', obfsPassword: params['salamander-password'] } : {})
        };
      }
    }),
    // Egern 的 bandwidth 会启用 Brutal 拥塞控制，不是订阅里的带宽提示，不读回（编译方向也不写）。
    egern: Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse: (proxy) => {
        const ports = normalizePortRanges(proxy.port_hopping);
        const fallbackPort = portWithFallback(proxy.port, ports);
        return {
          password: optionalString(proxy.auth),
          tls: true,
          ...egernTlsFields(proxy),
          obfs: optionalString(proxy.obfs),
          obfsPassword: optionalString(proxy.obfs_password),
          ports,
          ...(fallbackPort ? { port: fallbackPort } : {})
        };
      }
    })
  }),
  parse: parseHysteriaLink,
  encode: encodeHysteriaLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'hysteria2';
      proxy.password = requiredString(node, 'password');
      if (node.sni) proxy.sni = String(node.sni);
      proxy['skip-cert-verify'] = Boolean(node.insecure || node.allowInsecure);
      if (node.obfs) {
        proxy.obfs = String(node.obfs);
        proxy['obfs-password'] = requiredString(node, 'obfsPassword');
      }
      if (node.upMbps !== undefined) {
        const value = Number(node.upMbps);
        if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_upMbps');
        proxy.up = `${value} Mbps`;
      }
      if (node.downMbps !== undefined) {
        const value = Number(node.downMbps);
        if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_downMbps');
        proxy.down = `${value} Mbps`;
      }
      // 端口跳跃：mihomo 的 ports 与 hop-interval（列表顺序规范化后写出）。
      const ports = formatPortRanges(node.ports);
      if (ports) proxy.ports = ports;
      if (node.hopInterval !== undefined) {
        const interval = hopIntervalOf(node.hopInterval);
        if (interval === undefined) throw new Error('invalid_proxy_field_hopInterval');
        proxy['hop-interval'] = interval;
      }
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password'),
        tls: buildTls(node, { force: true })
      };
      // 端口跳跃：有 server_ports 时不能再写 server_port；sing-box 的每一项都必须是「起:止」。
      const serverPorts = formatPortRanges(node.ports, { rangeSeparator: ':', alwaysRange: true });
      if (serverPorts) {
        delete outbound.server_port;
        outbound.server_ports = serverPorts.split(',');
      }
      if (node.hopInterval !== undefined) {
        // sing-box 的 hop_interval 是时长字符串。
        const interval = hopIntervalOf(node.hopInterval);
        if (interval === undefined) throw new Error('invalid_proxy_field_hopInterval');
        outbound.hop_interval = `${interval}s`;
      }
      if (node.upMbps !== undefined) outbound.up_mbps = Number(node.upMbps);
      if (node.downMbps !== undefined) outbound.down_mbps = Number(node.downMbps);
      const obfsType = String(node.obfs || '').trim();
      const obfsPassword = String(node.obfsPassword || '').trim();
      if (obfsType || obfsPassword) {
        outbound.obfs = {
          type: obfsType || 'salamander',
          password: requireSingBoxString(obfsPassword, 'missing_required_proxy_field_obfsPassword')
        };
      }
      return outbound;
    },
    surge(node) {
      if (node.obfs || node.obfsPassword) throw surgeError('unsupported_hysteria2_obfs');
      return {
        type: 'hysteria2',
        params: {
          password: requiredText(node, 'password'),
          ...surgeTlsParams(node),
          'port-hopping': formatPortRanges(node.ports, { separator: ';' }),
          'download-bandwidth': node.downMbps
        }
      };
    },
    loon(node) {
      const obfs = String(node.obfs || '').trim().toLowerCase();
      if (obfs && obfs !== 'salamander') throw surgeError(`unsupported_hysteria2_obfs_${obfs}`);
      return {
        type: 'Hysteria2',
        args: [quoted(requiredText(node, 'password'))],
        params: {
          ...loonTlsParams(node, { forceTls: true }),
          // Loon 的 server-ports 区间用冒号（`server-ports="20000:20100"`）。
          'server-ports': formatPortRanges(node.ports, { rangeSeparator: ':' }),
          'download-bandwidth': node.downMbps,
          'salamander-password': obfs ? quoted(requiredText(node, 'obfsPassword')) : undefined,
          udp: true
        }
      };
    },
    // 带宽（bandwidth）会让 Egern 启用 Brutal 拥塞控制，不从订阅的带宽提示推断。
    egern(node) {
      const obfs = String(node.obfs || '').trim().toLowerCase();
      if (obfs && obfs !== 'salamander') throw surgeError(`unsupported_hysteria2_obfs_${obfs}`);
      return {
        type: 'hysteria2',
        fields: {
          auth: requiredValue(node, 'password'),
          ...egernTls(node),
          obfs: obfs || undefined,
          obfs_password: obfs ? requiredValue(node, 'obfsPassword') : undefined,
          port_hopping: formatPortRanges(node.ports)
        }
      };
    }
  })
});
