'use strict';

// 同时提供 Anthropic 与 OpenAI 两种协议的**厂商端点对照表**。
//
// 数据源是 contracts/vendor-endpoints/endpoints.json（Go 侧用 go:embed 读同一份
// 文件，见 contracts/vendor-endpoints/contract.go）。两侧共享一份事实，避免
// 「Node 认识千问、Go 不认识」这类漂移。
//
// 背景（2026-11-03）：用户把 DeepSeek 官方的 Anthropic 兼容地址
// (`https://api.deepseek.com/anthropic`) 加进 claude Provider，再用
// `aih codex --model-alias claude.deepseek-flash` 从 codex 调它。请求因此走
// 「OpenAI Responses → Anthropic Messages」适配层；DeepSeek 的 Anthropic 兼容层
// 对工具调用的转译不完整，模型会把原生的 DSML 调用文本直接吐给客户端。
// 同一家厂商的 OpenAI 端点 (`https://api.deepseek.com/v1`) 没有这层转译。
//
// 契约只登记**有官方文档/实测依据**的双协议端点。未知地址一律返回空串——
// 猜一个「去掉 /anthropic 再拼 /v1」的规则会把任意 Anthropic 代理指向错误的上游，
// 那比不适配更难排障。新增一家厂商 = 往 JSON 里加一条。

const contract = require('../../contracts/vendor-endpoints/endpoints.json');

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

// OpenAI 端点的基址本身就以版本段结尾（/v1、/api/paas/v4、/compatible-mode/v1），
// 与 Anthropic 端点不同，不能套用「去掉 /v1」的归一化。
function parseOpenAIEndpoint(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      origin: url.origin.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      pathname: normalizePathname(url.pathname)
    };
  } catch (_error) {
    return null;
  }
}

function buildEntries(vendors) {
  const entries = [];
  (Array.isArray(vendors) ? vendors : []).forEach((vendor) => {
    const anthropicBaseUrl = String(vendor && vendor.protocols && vendor.protocols.anthropic
      ? vendor.protocols.anthropic.base_url || '' : '').trim();
    const openaiBaseUrl = String(vendor && vendor.protocols && vendor.protocols.openai
      ? vendor.protocols.openai.base_url || '' : '').trim();
    if (!anthropicBaseUrl || !openaiBaseUrl) return;
    const anthropicEndpoint = parseEndpoint(anthropicBaseUrl);
    const openaiEndpoint = parseOpenAIEndpoint(openaiBaseUrl);
    if (!anthropicEndpoint || !openaiEndpoint) return;
    entries.push(Object.freeze({
      vendor: String(vendor.id || '').trim(),
      label: String(vendor.label || vendor.id || '').trim(),
      anthropicBaseUrl,
      anthropicPath: anthropicEndpoint.pathname,
      anthropicHostname: anthropicEndpoint.hostname,
      openaiBaseUrl,
      openaiHostname: openaiEndpoint.hostname,
      openaiPath: openaiEndpoint.pathname
    }));
  });
  return Object.freeze(entries);
}

const DUAL_FORMAT_ENDPOINTS = buildEntries(contract && contract.vendors);

/**
 * Anthropic 兼容地址 → 同一厂商的 OpenAI 兼容基址（含版本段，调用方只需再拼
 * `/chat/completions`）。不是已知双协议端点时返回空串。
 */
function resolveOpenAICompatibleBaseUrl(baseUrl) {
  const endpoint = parseEndpoint(baseUrl);
  if (!endpoint) return '';
  const entry = DUAL_FORMAT_ENDPOINTS.find((item) => (
    item.anthropicPath === endpoint.pathname
    && item.anthropicHostname === endpoint.hostname
  ));
  return entry ? entry.openaiBaseUrl : '';
}

/**
 * OpenAI 兼容地址 → 同一厂商的 Anthropic 兼容基址（不含 /v1，调用方只需再拼
 * `/v1/messages`）。不是已知双协议端点时返回空串。
 */
function resolveAnthropicCompatibleBaseUrl(baseUrl) {
  const endpoint = parseOpenAIEndpoint(baseUrl);
  if (!endpoint) return '';
  const entry = DUAL_FORMAT_ENDPOINTS.find((item) => (
    item.openaiPath === endpoint.pathname
    && item.openaiHostname === endpoint.hostname
  ));
  return entry ? entry.anthropicBaseUrl : '';
}

function listDualFormatEndpoints() {
  return DUAL_FORMAT_ENDPOINTS.map((entry) => ({ ...entry }));
}

module.exports = {
  DUAL_FORMAT_ENDPOINTS,
  listDualFormatEndpoints,
  resolveAnthropicCompatibleBaseUrl,
  resolveOpenAICompatibleBaseUrl,
  __private: {
    normalizeAnthropicPath,
    parseEndpoint,
    parseOpenAIEndpoint
  }
};
