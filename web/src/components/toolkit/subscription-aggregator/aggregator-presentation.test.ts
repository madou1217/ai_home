import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolicyOptions,
  buildSubscriptionUrl,
  describeSourceOrigin,
  describeSourceScope,
  formatBytes,
  formatTraffic,
  linkFormatOptions,
  maskSourceUrl,
  parseBatchSources,
  policyLabel,
  previewWarningText,
  describeSourcePreview,
  importFormatLabel,
  nameWithFlag,
  summarizeSkipReasons,
  describePull,
  formatPullTime,
  groupClientsByFormat,
  isLoopbackOrigin,
  protocolOptions,
  skipReasonText,
  sortImportClients,
  utf8ByteLength
} from './aggregator-presentation.ts';

const context = {
  catalog: {
    regions: [{ id: 'hk', code: 'HK', name: '香港', flag: '🇭🇰' }],
    presets: [{ id: 'ai', name: '🤖 AI 服务', description: '', defaultPolicy: 'proxy', enabledByDefault: true }]
  },
  sources: [{ id: 'sub_a', name: '机场A' }]
};

test('流量按 1024 进位并合并上下行', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(200 * 1024 ** 3), '200 GB');
  assert.equal(formatTraffic({ upload: 1024 ** 3, download: 1024 ** 3, total: 100 * 1024 ** 3 }), '2.0 GB / 100 GB');
  assert.equal(formatTraffic(null), '');
});

test('订阅链接按格式追加 target 参数', () => {
  assert.equal(buildSubscriptionUrl('http://127.0.0.1:9527/', '/sub/abc', 'auto'), 'http://127.0.0.1:9527/sub/abc');
  assert.equal(buildSubscriptionUrl('http://h', '/sub/abc', 'sing-box'), 'http://h/sub/abc?target=sing-box');
});

test('策略引用翻译成组名，未知引用原样显示', () => {
  assert.equal(policyLabel('proxy', context), '🚀 节点选择');
  assert.equal(policyLabel('region:hk', context), '🇭🇰 香港节点');
  assert.equal(policyLabel('source:sub_a', context), '📦 机场A');
  assert.equal(policyLabel('preset:ai', context), '🤖 AI 服务');
  assert.equal(policyLabel('region:mars', context), 'region:mars');
});

test('策略选项只在需要时包含订阅源组与规则组', () => {
  assert.deepEqual(buildPolicyOptions(context).map((group) => group.label), ['内置', '地区']);
  assert.deepEqual(
    buildPolicyOptions({ ...context, includeSources: true, includePresets: true }).map((group) => group.label),
    ['内置', '地区', '订阅源', '规则组']
  );
});

test('自建组出现在策略选项里，标签取当前名称', () => {
  const withGroups = { ...context, groups: [{ id: 'grp_1', name: 'YouTube' }, { id: 'grp_2', name: '  ' }] };
  assert.deepEqual(buildPolicyOptions(withGroups).map((group) => group.label), ['内置', '自建组', '地区']);
  assert.deepEqual(buildPolicyOptions(withGroups)[1].options, [
    { label: 'YouTube', value: 'group:grp_1' },
    { label: '未命名策略组', value: 'group:grp_2' }
  ]);
  assert.equal(policyLabel('group:gone', withGroups), '已删除的策略组');
});

test('预览提示把警告码换成说明', () => {
  const describe = (policy: string) => policyLabel(policy, context);
  assert.equal(previewWarningText('aggregator_no_nodes'), '没有节点被选中，检查订阅源范围与过滤条件');
  assert.equal(
    previewWarningText('aggregator_group_member_missing:韩国:专用:region:hk', describe),
    '「韩国:专用」套用的 🇭🇰 香港节点 没有生成（分组没开启或没有节点），已从组里去掉'
  );
  assert.equal(previewWarningText('aggregator_group_type_degraded:AI:fallback'), '这个格式不支持故障转移，「AI」改成了延迟最低');
  assert.equal(
    previewWarningText('aggregator_policy_fallback:preset:ai:region:hk', describe),
    '「preset:ai」引用的 🇭🇰 香港节点 没有对应策略组，已改用节点选择'
  );
  assert.equal(previewWarningText('something_new'), 'something_new');
});

test('批量粘贴识别名称与地址，非法行单独返回', () => {
  const result = parseBatchSources([
    'https://a.example.com/sub?token=1',
    '机场B https://b.example/sub',
    '机场C,https://c.example/sub',
    '机场D | https://d.example/sub',
    '',
    'not a url'
  ].join('\n'));
  assert.deepEqual(result.sources, [
    { name: 'a.example.com', url: 'https://a.example.com/sub?token=1' },
    { name: '机场B', url: 'https://b.example/sub' },
    { name: '机场C', url: 'https://c.example/sub' },
    { name: '机场D', url: 'https://d.example/sub' }
  ]);
  assert.deepEqual(result.invalid, ['not a url']);
});

test('订阅源范围描述', () => {
  assert.equal(describeSourceScope({ sources: { all: true, subscriptionIds: [], includeManualNodes: false } }, 10), '全部订阅源（10）');
  assert.equal(describeSourceScope({ sources: { all: false, subscriptionIds: ['a', 'b'], includeManualNodes: true } }, 10), '2 个订阅源 + 手动节点');
});

test('订阅地址只显示域名与路径，查询串整体隐藏', () => {
  assert.equal(maskSourceUrl('https://sub.example.com/api/v1/client?OuO=abc&name=x'), 'https://sub.example.com/api/v1/client?…');
  assert.equal(maskSourceUrl('https://sub.example.com/link/abc'), 'https://sub.example.com/link/abc');
});

test('格式与协议选项来自服务端 catalog，订阅链接额外有「自动识别」', () => {
  const formats = [{ id: 'mihomo', name: 'Clash Meta（mihomo）' }, { id: 'surge', name: 'Surge' }];
  assert.deepEqual(linkFormatOptions(formats).map((option) => option.value), ['auto', 'mihomo', 'surge']);
  assert.deepEqual(protocolOptions(['tuic', 'snell']), [{ label: 'tuic', value: 'tuic' }, { label: 'snell', value: 'snell' }]);
});

test('订阅源来源说明：远程脱敏地址（附自定义 UA），本地显示内容行数', () => {
  assert.equal(describeSourceOrigin({ kind: 'remote', url: 'https://a.example/sub?token=x', userAgent: null }), 'https://a.example/sub?…');
  assert.equal(describeSourceOrigin({ kind: 'remote', url: 'https://a.example/sub', userAgent: 'v2rayN/6.42' }), 'https://a.example/sub · UA v2rayN/6.42');
  assert.equal(describeSourceOrigin({ kind: 'local', url: null, content: 'trojan://a\n\n  \nvless://b\n' }), '本地内容 · 2 行');
  assert.equal(utf8ByteLength('香港'), 6);
});

test('预览里未输出节点的原因译成可读文本，未知码原样显示', () => {
  assert.equal(skipReasonText('unsupported_proxy_protocol_wireguard'), '不支持 wireguard');
  assert.equal(skipReasonText('unsupported_proxy_protocol_tuic-v4'), '不支持 TUIC v4');
  assert.equal(skipReasonText('unsupported_proxy_transport_grpc'), '不支持 grpc 传输');
  assert.equal(skipReasonText('unsupported_snell_version_4'), '不支持 Snell v4');
  assert.equal(skipReasonText('unsupported_sing_box_snell_version_3'), 'sing-box 不支持 Snell v3');
  assert.equal(skipReasonText('unsupported_sing_box_snell_obfs_tls'), 'sing-box 不支持 Snell 的 tls 混淆');
  assert.equal(skipReasonText('unsupported_surge_snell_shadow_tls'), 'Surge 的 Snell 不支持 ShadowTLS');
  assert.equal(skipReasonText('unsupported_shadowsocks_plugin_shadow-tls'), '不支持 SS 插件 shadow-tls');
  assert.equal(skipReasonText('requires_sing_box_1.14.0'), '需要 sing-box ≥ 1.14.0');
  assert.equal(skipReasonText('requires_sing_box_official_app'), '需要 sing-box 官方 App（自带 libcronet）');
  assert.equal(skipReasonText('unsupported_hysteria2_obfs'), '不支持 Hysteria2 混淆');
  assert.equal(skipReasonText('missing_required_proxy_field_upMbps'), '缺少字段 upMbps');
  assert.equal(skipReasonText('something_else'), 'something_else');
});

test('拉取记录：相对时间与客户端 / 格式 / 视图 / 节点数说明', () => {
  const now = 10 * 60 * 60 * 1000;
  assert.equal(formatPullTime(now - 20 * 1000, now), '刚刚');
  assert.equal(formatPullTime(now - 5 * 60 * 1000, now), '5 分钟前');
  assert.equal(formatPullTime(now - 3 * 60 * 60 * 1000, now), '3 小时前');
  const formats = [{ id: 'sing-box', name: 'sing-box' }];
  assert.equal(describePull({ clientName: 'Hiddify', format: 'sing-box', view: 'nodes', nodes: 12 }, formats), 'Hiddify · sing-box（仅节点） · 12 个节点');
  assert.equal(skipReasonText('requires_sing_box_1.12.0'), '需要 sing-box ≥ 1.12.0');
});

test('自动识别的客户端按格式分组，格式顺序跟服务端一致，没有客户端的格式不列', () => {
  const formats = [{ id: 'mihomo', name: 'mihomo' }, { id: 'stash', name: 'Stash' }, { id: 'base64', name: 'Base64' }];
  const clients = [
    { name: 'Clash Verge Rev', format: 'mihomo' },
    { name: 'v2rayN', format: 'base64' },
    { name: 'FlClash', format: 'mihomo' }
  ];
  assert.deepEqual(groupClientsByFormat(clients, formats), [
    { format: 'mihomo', formatName: 'mihomo', clientNames: ['Clash Verge Rev', 'FlClash'] },
    { format: 'base64', formatName: 'Base64', clientNames: ['v2rayN'] }
  ]);
});

test('导入：本机地址判断与已安装客户端排前面', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:9527'), true);
  assert.equal(isLoopbackOrigin('http://localhost:9527'), true);
  assert.equal(isLoopbackOrigin('http://[::1]:9527'), true);
  assert.equal(isLoopbackOrigin('http://192.168.31.10:9527'), false);
  assert.equal(isLoopbackOrigin('not a url'), false);
  const clients = [{ id: 'stash', scheme: 'stash' }, { id: 'v2rayn', scheme: '' }, { id: 'clash', scheme: 'clash' }];
  assert.deepEqual(sortImportClients(clients, { clash: 'Clash Verge', stash: null }).map((client) => client.id), ['clash', 'stash', 'v2rayn']);
});

test('解析预览说明识别出的格式、节点数与跳过原因', () => {
  assert.equal(importFormatLabel('xray'), 'Xray / V2Ray 配置（v2rayN 等导出）');
  assert.equal(importFormatLabel('base64+uri'), 'Base64 包裹的分享链接');
  assert.equal(importFormatLabel(''), '未识别的内容');
  assert.equal(
    describeSourcePreview({ format: 'clash', nodes: [{ name: 'a', protocol: 'vless', server: 'x', port: 1, flag: '' }], skippedNodes: [{ name: 'b', reason: 'x' }] }),
    '识别为Clash / mihomo 配置：1 个节点，跳过 1 个'
  );
  assert.equal(describeSourcePreview({ format: '', nodes: [], skippedNodes: [] }), '没有识别出节点');
  assert.deepEqual(
    summarizeSkipReasons([
      { reason: 'unsupported_proxy_transport_kcp' },
      { reason: 'invalid_proxy_link_vless' },
      { reason: 'unsupported_proxy_transport_kcp' }
    ]),
    [{ text: '不支持 kcp 传输', count: 2 }, { text: 'vless 链接格式不对', count: 1 }]
  );
});

test('国旗只在名称里没有时补上', () => {
  assert.equal(nameWithFlag('香港 01', '🇭🇰'), '🇭🇰 香港 01');
  assert.equal(nameWithFlag('🇨🇳 中国台湾 Egern', '🇨🇳'), '🇨🇳 中国台湾 Egern');
  assert.equal(nameWithFlag('WireGuard 203.0.113.10', '🌐'), 'WireGuard 203.0.113.10');
  assert.equal(nameWithFlag('x', ''), 'x');
});
