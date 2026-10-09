import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolicyOptions,
  buildSubscriptionUrl,
  describeSourceScope,
  formatBytes,
  formatTraffic,
  maskSourceUrl,
  parseBatchSources,
  policyLabel
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
