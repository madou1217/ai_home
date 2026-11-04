'use strict';

// 同时提供 Anthropic 与 OpenAI 两种协议的**厂商端点对照表**。
//
// 背景（2026-11-03）：用户把 DeepSeek 官方的 Anthropic 兼容地址
// (`https://api.deepseek.com/anthropic`) 加进 claude Provider，再用
// `aih codex --model-alias claude.deepseek-flash` 从 codex 调它。请求因此走
// 「OpenAI Responses → Anthropic Messages」适配层；DeepSeek 的 Anthropic 兼容层
// 对工具调用的转译不完整，模型会把原生的 DSML 调用文本直接吐给客户端。
// 同一家厂商的 OpenAI 端点 (`https://api.deepseek.com/v1`) 没有这层转译。
//
// 这里只登记**有官方文档/实测依据**的双协议端点。未知地址一律返回空串——
// 猜一个「去掉 /anthropic 再拼 /v1」的规则会把任意 Anthropic 代理指向错误的上游，
// 那比不适配更难排障。
//
// 表项的形状是厂商级事实，不是路由分支：新增一家厂商 = 加一行。

const DUAL_FORMAT_ENDPOINTS = Object.freeze([
  Object.freeze({
    vendor: 'deepseek',
    anthropicPath: '/anthropic',
    openaiBaseUrl: 'https://api.deepseek.com/v1'
  }),
  Object.freeze({
    vendor: 'moonshot',
    anthropicPath: '/anthropic',
    openaiBaseUrl: 'https://api.moonshot.cn/v1'
  }),
  Object.freeze({
    vendor: 'moonshot-intl',
    anthropicPath: '/anthropic',
    openaiBaseUrl: 'https://api.moonshot.ai/v1'
  }),
  Object.freeze({
    vendor: 'bigmodel',
    anthropicPath: '/api/anthropic',
    openaiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  }),
  Object.freeze({
    vendor: 'zai',
    anthropicPath: '/api/anthropic',
    openaiBaseUrl: 'https://api.z.ai/api/paas/v4'
  }),
  Object.freeze({
    vendor: 'dashscope',
    anthropicPath: '/apps/anthropic',
    openaiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  }),
  Object.freeze({
    vendor: 'dashscope-intl',
    anthropicPath: '/apps/anthropic',
    openaiBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  })
]);

function normalizePathname(pathname) {
  const value = String(pathname || '').trim();
  if (!value || value === '/') return '/';
  return value.replace(/\/+$/, '') || '/';
}

// 账号里可能存 `…/anthropic`，也可能存 `…/anthropic/v1`（Anthropic SDK 形态）。
// 两种情况指同一个兼容端点，比较前统一去掉末尾的 /v1。
function normalizeAnthropicPath(pathname) {
  const path = normalizePathname(pathname);
  return path.replace(/\/v1$/i, '') || '/';
}

function parseEndpoint(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      origin: url.origin.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      pathname: normalizeAnthropicPath(url.pathname)
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Anthropic 兼容地址 → 同一厂商的 OpenAI 兼容基址（含版本段，调用方只需再拼
 * `/chat/completions`）。不是已知双协议端点时返回空串。
 */
function resolveOpenAICompatibleBaseUrl(baseUrl) {
  const endpoint = parseEndpoint(baseUrl);
  if (!endpoint) return '';
  const entry = DUAL_FORMAT_ENDPOINTS.find((item) => (
    item.anthropicPath === endpoint.pathname
    && new URL(item.openaiBaseUrl).hostname.toLowerCase() === endpoint.hostname
  ));
  return entry ? entry.openaiBaseUrl : '';
}

function listDualFormatEndpoints() {
  return DUAL_FORMAT_ENDPOINTS.map((entry) => ({ ...entry }));
}

module.exports = {
  DUAL_FORMAT_ENDPOINTS,
  listDualFormatEndpoints,
  resolveOpenAICompatibleBaseUrl,
  __private: {
    normalizeAnthropicPath,
    parseEndpoint
  }
};
