'use strict';

// 官方上游的地区策略（provider 描述符 egress.regionPolicy 的数据源）。
//
// 这些**只是提示**：判定优先级是「用户规则 > 实测 > 提示」，节点实测通过就推翻提示，
// 上游开放 / 新增地区不需要改这里（见 lib/server/egress-region-policy.js）。
// 每条提示必须写明出处与日期（契约强制），UI 原样展示，过时一眼可见。
// 拒绝特征（denySignatures）是上游拒绝该地区时的响应文本，用于从真实流量里认出「地区被拒」。

const AS_OF = '2026-10-19';

const ANTHROPIC = Object.freeze({
  hints: [{
    effect: 'deny',
    match: { country: ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'] },
    note: 'Anthropic 支持地区列表不含这些地区',
    source: 'https://www.anthropic.com/supported-countries',
    asOf: AS_OF
  }],
  denySignatures: [
    'request not allowed',
    'unsupported_country',
    'not available in your country',
    'not available in your region'
  ]
});

const OPENAI = Object.freeze({
  hints: [{
    effect: 'deny',
    match: { country: ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'] },
    note: 'OpenAI 支持地区列表不含这些地区',
    source: 'https://platform.openai.com/docs/supported-countries',
    asOf: AS_OF
  }],
  denySignatures: [
    'unsupported_country_region_territory',
    'country, region, or territory not supported',
    'not available in your country'
  ]
});

const GOOGLE = Object.freeze({
  hints: [{
    effect: 'deny',
    match: { country: ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'] },
    note: 'Gemini API 可用地区列表不含这些地区',
    source: 'https://ai.google.dev/gemini-api/docs/available-regions',
    asOf: AS_OF
  }],
  denySignatures: [
    'user location is not supported',
    'location is not supported for the api use',
    'not available in your country'
  ]
});

module.exports = { ANTHROPIC, GOOGLE, OPENAI };
