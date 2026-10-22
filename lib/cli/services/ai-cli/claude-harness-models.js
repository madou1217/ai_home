'use strict';

// 跨 Provider harness（`aih claude <accountRef>`，身份账号属于别的 Provider）的模型可见性。
//
// Claude Code 的 /model 选择器默认只有内置 Claude 条目，钉选到 GPT / Gemini 账号时会话里
// 看不到任何能用的模型。官方的「网关模型发现」（CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1）
// 只保留 id 里含 claude / anthropic 的条目（code.claude.com/docs/en/llm-gateway-protocol#model-discovery），
// 对跨 Provider 账号反而只会带进一批该账号路由不到的 Claude 模型（选中即 503 并触发自动重试），
// 因此这里改用 `modelPicker`（Claude Code 明确支持从 --settings 读取，v2.1.242+）把
// **钉选账号自己的模型目录**逐行加进选择器。
//
// 目录来自服务端已持久化的模型快照（app-state 的 cache:webui-models-snapshot.json）。
// 读不到、为空或形状不认识时整体跳过：启动绝不因为目录缺失而失败。
//
// 上下文窗口：Claude Code 对不认识的 id 按 200k 自动压缩（会过早触发自动 compact）。
// 这里按「快照探测值优先、models.dev 离线目录兜底」的顺序注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS。
// 只对非 claude 前缀的 id 注入——Claude Code 自己认识 claude-* 的窗口，覆盖它只会更糟。

const { readPersistedWebUiModelsCache } = require('../../../server/webui-model-cache');
const { createModelsDevReader } = require('../../../server/models-dev-metadata');
const { CLAUDE_MODEL_PICKER_ROW_LIMIT } = require('../../config/constants');

const CLAUDE_CONTEXT_TOKENS_ENV = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
const CLAUDE_MODEL_PICKER_KEY = 'modelPicker';

/** 读取 `--model <id>` / `--model=<id>`（`--` 之后是原生透传，不解析）。 */
function readModelFlagValue(args) {
  const source = Array.isArray(args) ? args : [];
  for (let index = 0; index < source.length; index += 1) {
    const token = String(source[index] || '');
    if (token === '--') break;
    if (token === '--model') return String(source[index + 1] || '').trim();
    if (token.startsWith('--model=')) return token.slice('--model='.length).trim();
  }
  return '';
}

function readStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

/**
 * 读钉选账号自己的模型目录快照。任何异常都降级成空目录（启动不因目录缺失而失败）。
 * `input.readModelsCache` 供测试注入；生产走服务端同一个快照读取器。
 */
function readClaudeHarnessModelCatalog(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const empty = { models: [], contextLimits: {}, labels: {} };
  if (!accountRef) return empty;
  const readCache = typeof input.readModelsCache === 'function'
    ? input.readModelsCache
    : readPersistedWebUiModelsCache;
  let cache = null;
  try {
    cache = readCache({ fs: input.fs, aiHomeDir: input.aiHomeDir });
  } catch (_error) {
    cache = null;
  }
  if (!cache || typeof cache !== 'object') return empty;
  const byAccount = cache.byAccount && typeof cache.byAccount === 'object' ? cache.byAccount : {};
  const models = readStringList(byAccount[accountRef]);
  if (models.length === 0) return empty;
  const limitsByAccount = cache.contextLimits && typeof cache.contextLimits === 'object'
    ? cache.contextLimits[accountRef]
    : null;
  const contextLimits = limitsByAccount && typeof limitsByAccount === 'object' ? limitsByAccount : {};
  const provider = String(input.provider || '').trim().toLowerCase();
  const providerLabels = cache.labels && provider && cache.labels[provider] && typeof cache.labels[provider] === 'object'
    ? cache.labels[provider]
    : {};
  const labels = {};
  models.forEach((model) => {
    const label = String(providerLabels[model] || '').trim();
    if (label && label !== model) labels[model] = label;
  });
  return { models, contextLimits, labels };
}

/**
 * 未识别模型 id 的上下文窗口：先看该账号的探测结果，再回落到 models.dev 离线目录。
 * 认识（claude-*）或查不到时返回 null——不猜、也不覆盖 Claude Code 自己的判断。
 */
function resolveHarnessModelContextTokens(input = {}) {
  const model = String(input.model || '').trim();
  if (!model || /^claude/i.test(model)) return null;
  const declared = Number(input.contextLimits && input.contextLimits[model]);
  if (Number.isFinite(declared) && declared > 0) return Math.floor(declared);
  let metadata = null;
  try {
    const readMetadata = typeof input.readModelMetadata === 'function'
      ? input.readModelMetadata
      : (entry) => createModelsDevReader().resolveEntry(entry);
    metadata = readMetadata({ id: model, provider: input.provider });
  } catch (_error) {
    metadata = null;
  }
  const limits = metadata && metadata.limits;
  const value = Number(limits && (limits.input || limits.context));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * 跨 Provider 启动的模型整形：`--settings` 里的 modelPicker 行 + 上下文窗口 env。
 * 两者都拿不到时返回 null（调用方按无整形启动）。
 */
function buildClaudeHarnessModelLaunch(input = {}) {
  const catalog = readClaudeHarnessModelCatalog(input);
  const settings = {};
  if (catalog.models.length > 0) {
    settings[CLAUDE_MODEL_PICKER_KEY] = {
      // 追加在内置条目之后：内置别名在原生 claude 账号上仍然有效，替换掉没有收益。
      replaceBuiltInOptions: false,
      options: catalog.models.slice(0, CLAUDE_MODEL_PICKER_ROW_LIMIT).map((model) => ({
        model,
        ...(catalog.labels[model] ? { label: catalog.labels[model] } : {})
      }))
    };
  }
  const model = readModelFlagValue(input.args);
  const contextTokens = resolveHarnessModelContextTokens({
    model,
    provider: input.provider,
    contextLimits: catalog.contextLimits,
    readModelMetadata: input.readModelMetadata
  });
  const env = {};
  if (contextTokens) env[CLAUDE_CONTEXT_TOKENS_ENV] = String(contextTokens);
  if (Object.keys(env).length === 0 && Object.keys(settings).length === 0) return null;
  return { env, settings };
}

module.exports = {
  CLAUDE_CONTEXT_TOKENS_ENV,
  CLAUDE_MODEL_PICKER_KEY,
  buildClaudeHarnessModelLaunch,
  readClaudeHarnessModelCatalog,
  readModelFlagValue,
  resolveHarnessModelContextTokens
};
