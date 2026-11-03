'use strict';

/**
 * `--model-alias` 的 CLI 侧解析（provider 与外部 harness 两条启动路径共用）。
 *
 * 用法：
 *   aih <cli> <account> --model modelA --model-alias modelB   → modelA=modelB
 *   aih <cli> <account> --model-alias modelB                  → *=modelB
 *   aih <cli> <account> --model-alias modelA=modelB           → modelA=modelB（显式写法）
 *
 * 只解析 `--` 之前的 token；`--` 之后一律原样透传，不抢原生 CLI 的同名参数。
 */

const {
  parseSessionModelAliasSpec,
  encodeSessionModelAlias,
  buildSessionModelAliasPathPrefix
} = require('../server/session-model-alias');
const { isLoopbackUrl } = require('../server/http-utils-code-assist');
const { normalizeServerPort } = require('../server/server-defaults');

const FLAG = '--model-alias';

// 规则怎么送到网关（语义见 lib/server/session-model-alias.js）：
//   header    —— relay 自己拼请求头（claude 的 ANTHROPIC_CUSTOM_HEADERS、
//                codex 的 model_providers.*.http_headers）；
//   base-url  —— 规则编进网关 base URL 的路径前缀（原生 CLI 没有自定义头通道，
//                但 aih 决定它连哪个 base URL）；
//   没登记    —— 两条通道都没有：只能在启动期把请求的模型换成目标模型。
const MODEL_ALIAS_TRANSPORTS = Object.freeze({
  claude: 'header',
  codex: 'header',
  gemini: 'base-url',
  codebuddy: 'base-url',
  codebuddycn: 'base-url',
  workbuddy: 'base-url',
  workbuddycn: 'base-url',
  kimi: 'base-url',
  cline: 'base-url',
  opencode: 'base-url'
});

/** @returns {'header'|'base-url'|''} */
function modelAliasTransport(provider) {
  return MODEL_ALIAS_TRANSPORTS[String(provider || '').trim().toLowerCase()] || '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从 argv 里摘掉 `--model-alias`，返回剩余参数与原始规则值。
 * @returns {{args: string[], alias: string, error?: string}}
 */
function extractModelAliasFlag(args) {
  const source = Array.isArray(args) ? args : [];
  const out = [];
  let alias = '';
  for (let index = 0; index < source.length; index += 1) {
    const token = String(source[index] == null ? '' : source[index]);
    if (token === '--') {
      out.push(...source.slice(index));
      break;
    }
    if (token === FLAG) {
      const next = source[index + 1];
      if (next == null || String(next).startsWith('--')) {
        return { args: out, alias: '', error: 'model_alias_value_missing' };
      }
      alias = String(next).trim();
      index += 1;
      continue;
    }
    if (token.startsWith(FLAG + '=')) {
      alias = token.slice(FLAG.length + 1).trim();
      if (!alias) return { args: out, alias: '', error: 'model_alias_value_missing' };
      continue;
    }
    out.push(source[index]);
  }
  if (alias && !parseSessionModelAliasSpec(alias)) return { args: out, alias: '', error: 'model_alias_value_invalid' };
  return { args: out, alias };
}

/** 读 `--model` 的值（不改动参数）。 */
function readModelFlagValue(args) {
  const source = Array.isArray(args) ? args : [];
  for (let index = 0; index < source.length; index += 1) {
    const token = String(source[index] == null ? '' : source[index]);
    if (token === '--') break;
    if (token === '--model') {
      const next = source[index + 1];
      return next == null || String(next).startsWith('--') ? '' : String(next).trim();
    }
    if (token.startsWith('--model=')) return token.slice('--model='.length).trim();
  }
  return '';
}

/**
 * 由启动参数得到本次会话的规则。
 * `--model` 给了就是具名规则，没给就是通配规则。
 * target 允许带 provider / 账号命名空间（`kiro.glm-5` / `kiro.1.glm-5`），拆分交给
 * parseSessionModelAliasSpec（和网关读头时同一套拆法）。
 * @returns {{source: string, target: string, provider?: string, account?: string}|null}
 */
function buildSessionModelAliasRule(input = {}) {
  const alias = text(input.alias);
  if (!alias) return null;
  const parsed = parseSessionModelAliasSpec(alias);
  if (!parsed) return null;
  // 显式 `source=target` 时 source 以写出来的为准；否则 --model 是 source，没有就通配。
  if (alias.includes('=')) return parsed;
  return { ...parsed, source: text(input.model) || '*' };
}

/** 规则 → 环境变量值（relay 由它派生 `x-aih-model-alias` 头）。 */
function sessionModelAliasEnvValue(rule) {
  return encodeSessionModelAlias(rule);
}

/**
 * 把规则挂到 base URL 的路径前缀上（第二条送达通道，见 session-model-alias 的 PATH_PREFIX）。
 *
 * 只有**确定是 aih 网关**的地址才改写：
 *   - `isGateway`：调用方已经知道这是网关 profile 的地址（opencode 的 overlay），无条件改写；
 *   - 否则只认本机回环地址——账号自己配的上游（Google / z.ai / 厂商 API）不是网关，
 *     给它加前缀只会让请求 404，规则本来也到不了这里。
 * 返回空串表示「这个地址用不了这条通道」，调用方据此提示而不是静默失败。
 */
function wrapSessionModelAliasBaseUrl(baseUrl, rule, options = {}) {
  const value = String(baseUrl || '').trim();
  const prefix = buildSessionModelAliasPathPrefix(rule);
  if (!value || !prefix) return '';
  if (options.isGateway !== true && !isLoopbackUrl(value, normalizeServerPort(options.serverPort))) return '';
  let url = null;
  try {
    url = new URL(value);
  } catch (_error) {
    return '';
  }
  // 已有前缀就原样返回：重复包装会让路径变成 /-/ma/x/-/ma/x/v1（幂等）。
  if (url.pathname.startsWith(prefix)) return value;
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
  url.pathname = `${prefix}${path}`;
  return url.toString().replace(/\/$/, '');
}

module.exports = {
  FLAG,
  MODEL_ALIAS_TRANSPORTS,
  modelAliasTransport,
  wrapSessionModelAliasBaseUrl,
  extractModelAliasFlag,
  readModelFlagValue,
  buildSessionModelAliasRule,
  sessionModelAliasEnvValue
};
