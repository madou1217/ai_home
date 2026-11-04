'use strict';

// 会话级「请按另一种上游协议访问」的请求头。
//
// 送达路径：CLI 检测到 `--model-alias claude.<model>`（claude 账号是双协议厂商的
// Anthropic 端点）+ 用户选择「自动适配协议」→ 把 `upstreamProtocol=openai_chat` 写进
// 已有的 AIH_CODEX_FLAGS 上下文 → codex-provider-args 翻译成
// `X-Aih-Upstream-Protocol`（见 lib/cli/services/ai-cli/codex-provider-args.js）。
//
// 这是**提示**而不是注入：网关只接受能力表里真实存在的 provider/protocol 组合
// （lib/account/upstream-protocol-variants.js），未知组合直接忽略；账号池还会再按
// 「该账号的地址能不能真的说这门协议」过滤一次。坏值最差等于没有提示，不会把请求
// 打到错误的上游。

const HEADER_NAME = 'x-aih-upstream-protocol';
const PROTOCOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function normalizeUpstreamProtocolHint(value) {
  const text = Array.isArray(value) ? value[0] : value;
  const protocol = String(text == null ? '' : text).trim().toLowerCase();
  return PROTOCOL_PATTERN.test(protocol) ? protocol : '';
}

/**
 * 从头里读提示；没有/非法返回空串。
 *
 * 头名可能被客户端拼成任意大小写（codex 的 -c http_headers 由我们自己生成，
 * 但仍按大小写不敏感比对，与 x-aih-model-alias 同一套约定）。
 */
function readUpstreamProtocolHint(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  for (const key of Object.keys(source)) {
    if (String(key).toLowerCase() === HEADER_NAME) {
      return normalizeUpstreamProtocolHint(source[key]);
    }
  }
  return '';
}

module.exports = {
  HEADER_NAME,
  normalizeUpstreamProtocolHint,
  readUpstreamProtocolHint
};
