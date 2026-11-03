'use strict';

// 手动填写节点的表单描述：控件与分区由协议插件声明的 fields 推出，标签集中在这里；
// 枚举选项、默认值、要隐藏的字段来自插件的 form（{ options, defaults, hidden }）。前端按描述通用渲染。

const { SUPPORTED_TRANSPORTS } = require('./proxy-protocol-contract');

const LABELS = Object.freeze({
  uuid: 'UUID',
  password: '密码',
  username: '用户名',
  cipher: '加密方式',
  plugin: '插件',
  pluginOpts: '插件参数',
  flow: '流控（flow）',
  security: '安全层',
  publicKey: '公钥（public key）',
  shortId: 'Short ID',
  alterId: 'alterId',
  type: '伪装类型',
  network: '传输',
  path: '路径',
  host: 'Host',
  serviceName: 'gRPC 服务名',
  tls: '启用 TLS',
  sni: 'SNI',
  alpn: 'ALPN',
  allowInsecure: '跳过证书验证',
  insecure: '跳过证书验证（协议层）',
  fingerprint: 'uTLS 指纹',
  authStr: '认证字符串',
  hysteriaProtocol: '传输协议',
  obfs: '混淆',
  obfsPassword: '混淆密码',
  obfsHost: '混淆 Host',
  upMbps: '上行带宽（Mbps）',
  downMbps: '下行带宽（Mbps）',
  ports: '端口跳跃（端口列表）',
  hopInterval: '端口跳跃间隔（秒）',
  ssrProtocol: '协议',
  ssrProtocolParam: '协议参数',
  ssrObfs: '混淆',
  ssrObfsParam: '混淆参数',
  psk: 'PSK',
  version: '版本',
  congestionControl: '拥塞控制',
  udpRelayMode: 'UDP 转发模式',
  privateKey: '私钥',
  presharedKey: '预共享密钥',
  ip: '本机 IPv4 地址',
  ipv6: '本机 IPv6 地址',
  mtu: 'MTU',
  reserved: 'reserved'
});

// 凭据类字段用密码框（可以点开查看）。
const SECRET_FIELDS = new Set(['uuid', 'password', 'psk', 'privateKey', 'presharedKey', 'authStr', 'obfsPassword']);
const SECTIONS = Object.freeze({
  transport: new Set(['network', 'path', 'host', 'serviceName', 'type']),
  tls: new Set(['tls', 'sni', 'alpn', 'allowInsecure', 'insecure', 'fingerprint', 'security', 'publicKey', 'shortId']),
  advanced: new Set(['upMbps', 'downMbps', 'mtu', 'reserved', 'congestionControl', 'udpRelayMode', 'ports', 'hopInterval'])
});
const CONTROLS = Object.freeze({
  string: 'text',
  boolean: 'switch',
  count: 'number',
  positive: 'number',
  port: 'number',
  'port-range': 'text',
  'string-list': 'tags',
  options: 'text',
  transport: 'select'
});
// 多个协议共用的枚举；插件 form.options 里同名的覆盖它。
const COMMON_OPTIONS = Object.freeze({
  network: [...SUPPORTED_TRANSPORTS],
  fingerprint: ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'],
  alpn: ['h2', 'http/1.1', 'h3']
});

function sectionOf(field) {
  for (const [section, fields] of Object.entries(SECTIONS)) if (fields.has(field)) return section;
  return 'basic';
}

/** 一个协议的表单：公共字段（名称、服务器、端口）在前，再按插件字段顺序列出。 */
function describeProtocolForm(plugin, protocol = plugin.protocols[0]) {
  const form = plugin.form || {};
  const hidden = new Set(form.hidden || []);
  const required = new Set(plugin.required || []);
  const fields = Object.entries(plugin.fields || {})
    .filter(([key]) => !hidden.has(key))
    .map(([key, type]) => {
      const options = (form.options || {})[key] || COMMON_OPTIONS[key];
      // 文本字段的选项只是建议（还能手填少见的值）；传输与数字字段的选项是固定取值。
      const control = SECRET_FIELDS.has(key) ? 'secret'
        : options && type === 'string' ? 'suggest'
          : options && CONTROLS[type] === 'number' ? 'select'
            : CONTROLS[type] || 'text';
      return {
        key,
        label: LABELS[key] || key,
        control,
        section: sectionOf(key),
        required: required.has(key),
        ...(options ? { options: options.map((value) => (typeof value === 'object' ? value : { value, label: String(value) })) } : {})
      };
    });
  return {
    protocol,
    name: plugin.name,
    defaults: { ...(form.defaults || {}), ...((form.protocolDefaults || {})[protocol] || {}) },
    fields
  };
}

/** 全部协议的表单（同一插件的多个协议名各列一份，例如 http / https）。 */
function describeProtocolForms() {
  const { PROTOCOL_PLUGINS } = require('./protocols');
  return PROTOCOL_PLUGINS.flatMap((plugin) => plugin.protocols.map((protocol) => describeProtocolForm(plugin, protocol)));
}

module.exports = {
  describeProtocolForm,
  describeProtocolForms
};
