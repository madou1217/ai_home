'use strict';

// 「AI 翻译」页面与全局悬浮窗的数据面。
//
// 端点（全部挂在 /v0/webui/translation 下，走既有 WebUI 鉴权门）：
//   GET  /v0/webui/translation/settings   读取默认值（源语言 / 目标语言 / 模型）
//   POST /v0/webui/translation/settings   写入默认值（部分字段即可）
//   GET  /v0/webui/translation/languages  语言目录（可设置默认值的白名单）
//   POST /v0/webui/translation/detect     语言检测（页面输入时实时调用）
//   GET  /v0/webui/translation/models     可作为翻译模型的候选（带可用账号数）
//   POST /v0/webui/translation/stream     流式翻译（SSE：start/delta/done/error）
//
// 为什么模型候选要在服务端算：翻译只需要「能对话的模型」，但要排除生图模型与不可用
// 账号，并带上 provider 让网关按家族路由。这些信息只有服务端的模型缓存 + 账号可用性
// 才知道；前端自己拼会与真实路由结论分叉（表现为「选了模型却 503」）。

const { loadAliasesSync } = require('./model-alias-store');
const { buildGatewayModelEntries, mergeGatewayModelEntries } = require('./gateway-model-list');
const {
  buildModelCapabilityIndex,
  listAvailableAccountRefsForModelProvider
} = require('./model-capability-index');
const { modelGeneratesImages } = require('./model-modality-index');
const { summarizeAccountAvailability } = require('./account-availability');
const { getProviderMenuLabel } = require('../provider-catalog');
const {
  AUTO_LANGUAGE,
  detectLanguage,
  isSupportedLanguage,
  languageLabel,
  listLanguages,
  normalizeLanguageCode
} = require('./translation-language');
const { buildTranslationMessages } = require('./translation-prompt');
const { runTranslationStream, TRANSLATION_BODY_BYTES } = require('./translation-runner');
const {
  readTranslationSettings,
  writeTranslationSettings
} = require('../account/translation-settings-store');

const TRANSLATION_BASE_PATH = '/v0/webui/translation';
// 单次翻译的原文上限：超过这个长度的请求是「文件翻译」，应该走聊天，而不是一个浮层。
const MAX_TRANSLATION_INPUT_CHARS = 40000;

function createRouteError(statusCode, code, detail) {
  const error = new Error(String(detail || code || 'translation_error'));
  error.statusCode = Number(statusCode) || 500;
  error.code = String(code || 'translation_error');
  error.detail = String(detail || error.message);
  return error;
}

function writeError(ctx, error) {
  ctx.writeJson(ctx.res, Number(error && error.statusCode) || 500, {
    ok: false,
    error: String(error && error.code || 'translation_error'),
    detail: String(error && (error.detail || error.message) || 'translation request failed')
  });
}

async function readJsonBody(ctx, maxBytes = TRANSLATION_BODY_BYTES) {
  const result = await ctx.readRequestBody(ctx.req, { maxBytes }).catch((error) => ({ __error: error }));
  if (!result || result.__error) {
    const error = result && result.__error;
    if (error && error.code === 'request_body_too_large') {
      throw createRouteError(413, 'request_body_too_large', '请求内容过大');
    }
    throw createRouteError(400, 'invalid_request_body', '无法读取请求内容');
  }
  try {
    return result.length > 0 ? JSON.parse(result.toString('utf8')) : {};
  } catch (_error) {
    throw createRouteError(400, 'invalid_json', '请求内容必须是合法 JSON');
  }
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME_DIR
    || ''
  ).trim();
}

// ---------------------------------------------------------------------------
// 模型候选
// ---------------------------------------------------------------------------

function collectAccountsForProvider(state, provider) {
  const pool = state && state.accounts && state.accounts[provider];
  return Array.isArray(pool) ? pool : [];
}

function countAvailableAccounts(state, provider, model, now) {
  const pool = collectAccountsForProvider(state, provider);
  if (pool.length === 0) return 0;
  const summary = summarizeAccountAvailability(pool, { model, provider, now });
  return Number(summary.available) || 0;
}

// 翻译页每次打开都会并行请求 settings / languages / models。模型目录的“形状”（有哪些
// 模型）来自能力索引 + 别名 + 目录设置，构建一次实测约 0.9s；而“可用账号数”只是账号
// 运行态的投影，几毫秒就能重算。两者分开缓存：
//   catalog      —— 静态模型条目 + 能力索引，只在账号池/目录/别名变化时后台重建；
//   materialized —— 带 availableAccountCount 的响应体，短 TTL 内直接复用。
// 请求路径上永远只做内存读取或轻量计数，绝不重建能力索引（那是 1~3s 的同步阻塞）。
const TRANSLATION_MODEL_COUNT_TTL_MS = 10 * 1000;
let translationModelCache = {
  key: '',
  builtAt: 0,
  catalog: null,
  materialized: null,
  materializedAt: 0
};
let translationModelRefreshing = false;

function buildTranslationModelCacheKey(ctx) {
  const state = (ctx && ctx.state) || {};
  const options = (ctx && ctx.options) || {};
  const cache = state.webUiModelsCache || {};
  const settings = state.modelCatalogSettings || {};
  const accountParts = [];
  const accounts = state.accounts || {};
  Object.keys(accounts).sort().forEach((provider) => {
    const pool = Array.isArray(accounts[provider]) ? accounts[provider] : [];
    accountParts.push(`${provider}:${pool.length}:${pool.map((account) => {
      const ref = String(account && (account.accountRef || account.cliAccountId || account.id) || '');
      const status = String(account && account.schedulableStatus || '');
      return `${ref}/${status}`;
    }).join(',')}`);
  });
  return [
    resolveAiHomeDir(ctx),
    String(options.provider || ''),
    String(cache.updatedAt || 0),
    String(settings.updatedAt || 0),
    String(state.modelAliasRevision || ''),
    accountParts.join('|')
  ].join('::');
}

function scheduleTranslationModelRefresh(ctx) {
  if (translationModelRefreshing) return;
  translationModelRefreshing = true;
  const snapshot = {
    state: ctx && ctx.state,
    options: ctx && ctx.options,
    aiHomeDir: resolveAiHomeDir(ctx),
    fs: (ctx && ctx.fs) || require('node:fs'),
    deps: (ctx && ctx.deps) || {}
  };
  setImmediate(() => {
    try {
      const catalog = computeTranslationModelCatalog(snapshot);
      translationModelCache = {
        key: buildTranslationModelCacheKey(snapshot),
        builtAt: Date.now(),
        catalog,
        // 新目录的可用账号数交给下一次请求现算：后台任务只承担无法省略的索引构建。
        materialized: null,
        materializedAt: 0
      };
    } catch (_error) {
      // 重建失败继续用旧目录：模型选择器不应因为一次扫描失败变成空列表。
    } finally {
      translationModelRefreshing = false;
    }
  });
}

function translationDefaultScore(model) {
  const id = String(model && model.id || '').toLowerCase();
  let score = 0;
  // 翻译不需要推理：thinking / pro 模型会把首字节拖到数秒，默认值优先 flash 档。
  if (id.includes('thinking')) score -= 200;
  if (id.includes('pro')) score -= 50;
  if (id.includes('image')) score -= 500;
  if (id.includes('flash')) score += 100;
  if (id.includes('lite')) score += 10;
  // 这两个是实测最稳定的快档；显式给一点加权，避免 3.8-flash-low 之类的
  // 「flash 名字但思考很重」的模型因为字母序排到前面。
  if (id === 'gemini-2.5-flash') score += 30;
  else if (id === 'gemini-3-flash') score += 20;
  return score;
}

function materializeTranslationCatalog(ctx, catalog, now = Date.now()) {
  const state = (ctx && ctx.state) || {};
  const models = ((catalog && catalog.models) || []).map((entry) => {
    const provider = entry.provider;
    let availableAccountCount = 0;
    if (provider) {
      availableAccountCount = entry.source === 'alias'
        ? countAvailableAccounts(state, provider, entry.id, now)
        : listAvailableAccountRefsForModelProvider(catalog.index, entry.id, provider, now).length;
    }
    return { ...entry, availableAccountCount };
  });
  models.sort((left, right) => {
    if (right.availableAccountCount !== left.availableAccountCount) {
      return right.availableAccountCount - left.availableAccountCount;
    }
    const scoreDiff = translationDefaultScore(right) - translationDefaultScore(left);
    if (scoreDiff) return scoreDiff;
    return left.id.localeCompare(right.id);
  });
  const preferred = models.find((model) => model.availableAccountCount > 0) || models[0] || null;
  return {
    models,
    defaultModel: preferred ? preferred.id : '',
    defaultProvider: preferred ? preferred.provider : ''
  };
}

function buildTranslationModelCatalog(ctx) {
  const key = buildTranslationModelCacheKey(ctx);
  const now = Date.now();
  const cached = translationModelCache;
  if (!cached.catalog) {
    // 首次构建（通常是启动预热，见 server.js）才做重活。
    const catalog = computeTranslationModelCatalog(ctx);
    const materialized = materializeTranslationCatalog(ctx, catalog, now);
    translationModelCache = {
      key,
      builtAt: now,
      catalog,
      materialized,
      materializedAt: now
    };
    return materialized;
  }
  if (cached.key !== key) {
    scheduleTranslationModelRefresh(ctx);
  }
  if (cached.materialized && now - cached.materializedAt < TRANSLATION_MODEL_COUNT_TTL_MS) {
    return cached.materialized;
  }
  // 只重算可用账号数（O(模型 × 账号) 的轻量计数），不重建能力索引。
  const materialized = materializeTranslationCatalog(ctx, cached.catalog, now);
  cached.materialized = materialized;
  cached.materializedAt = now;
  return materialized;
}

function computeTranslationModelCatalog(ctx) {
  const state = (ctx && ctx.state) || {};
  const options = (ctx && ctx.options) || {};
  const aiHomeDir = resolveAiHomeDir(ctx);
  const fsImpl = (ctx && ctx.fs) || require('node:fs');

  let aliases = [];
  if (aiHomeDir && typeof loadAliasesSync === 'function') {
    try {
      aliases = loadAliasesSync(fsImpl, aiHomeDir, (ctx && ctx.deps) || {}).aliases || [];
    } catch (_error) {
      aliases = [];
    }
  }

  // 能力索引只建一次：buildGatewayModelEntries 内部按 provider 逐个重建会让一次请求
  // 变成 16 次全量扫描（实测 1~2 秒）。别名条目仍用账号池摘要，因为别名 id 不在
  // 能力索引的 modelLookup 里，直接查索引会永远得到 0。
  const modelCapabilityIndex = buildModelCapabilityIndex(state, options);
  const rawEntries = buildGatewayModelEntries(state, options, modelCapabilityIndex);
  const entries = mergeGatewayModelEntries(rawEntries, aliases, {
    state,
    options,
    modelCapabilityIndex,
    modelCatalogSettings: state.modelCatalogSettings || null
  });

  const seen = new Set();
  const models = [];
  entries.forEach((entry) => {
    const id = String(entry && entry.id || '').trim();
    if (!id || seen.has(id)) return;
    // 生图模型不是翻译模型：选到它只会拿到「没有文本」。
    if (modelGeneratesImages(id, { provider: entry.provider })) return;
    const provider = String(entry.provider || '').trim().toLowerCase();
    // 别名/聚合条目的 provider 可能为空：网关仍能按模型 id 路由，继续保留。
    if (!provider && entry.source !== 'alias') return;
    seen.add(id);
    models.push({
      id,
      provider,
      providerLabel: provider ? getProviderMenuLabel(provider) : '别名',
      source: String(entry.source || 'capability'),
      origin: String(entry.origin || '')
    });
  });

  return { models, index: modelCapabilityIndex };
}

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

function normalizeTextLimit(text) {
  const source = String(text == null ? '' : text);
  if (source.length > MAX_TRANSLATION_INPUT_CHARS) {
    throw createRouteError(
      413,
      'translation_input_too_large',
      `单次翻译最多 ${MAX_TRANSLATION_INPUT_CHARS} 字符`
    );
  }
  return source;
}

function resolveRequestLanguages(body) {
  const rawTarget = normalizeLanguageCode(body && body.target);
  const target = isSupportedLanguage(rawTarget) ? rawTarget : '';
  if (!target) throw createRouteError(400, 'translation_target_unsupported', '目标语言不受支持');
  const rawSource = normalizeLanguageCode(body && body.source);
  const source = rawSource === AUTO_LANGUAGE || isSupportedLanguage(rawSource) ? rawSource : AUTO_LANGUAGE;
  return { source, target };
}

function resolveRequestModel(body, fallbackCatalog) {
  let model = String(body && body.model || '').trim();
  let provider = String(body && body.provider || '').trim().toLowerCase();
  const catalogModels = Array.isArray(fallbackCatalog && fallbackCatalog.models)
    ? fallbackCatalog.models
    : [];
  // 目录里的完整 id 是「前缀是否为合法命名空间」的唯一裁决依据：
  // `opencode/glm-5.3-flash-free`、`cline-pass/...` 这类 id 本身带命名空间，
  // 拆掉前缀会让网关按裸名选号，落进「没有账号能服务该模型」。
  const exactModelInCatalog = (id) => catalogModels
    .some((item) => String(item && item.id || '').trim() === id);
  // 显式 provider + 冗余的 `provider/` 前缀（历史调用方曾这样拼）：
  // 只有目录里不存在这个完整 id 时才剥掉前缀，命名空间型 id 原样保留。
  if (model && provider && model.length > provider.length
    && model.slice(0, provider.length + 1).toLowerCase() === `${provider}/`
    && !exactModelInCatalog(model)) {
    model = model.slice(provider.length + 1);
  }
  // 允许前端只传 "provider/model" 这种带前缀的写法；同样先看目录里有没有完整 id。
  if (model && !provider && model.includes('/') && !exactModelInCatalog(model)) {
    const separator = model.indexOf('/');
    const prefix = model.slice(0, separator);
    if (catalogModels.some((item) => item.provider === prefix)) {
      provider = prefix;
      model = model.slice(separator + 1);
    }
  }
  if (!model) {
    model = fallbackCatalog.defaultModel;
    provider = provider || fallbackCatalog.defaultProvider;
  }
  if (!model) {
    throw createRouteError(409, 'translation_model_unavailable', '当前没有可用作翻译的模型');
  }
  return { model, provider };
}

function resolveTranslationFallbackCatalog(catalog, settings) {
  const base = catalog || { models: [] };
  const model = String(settings && settings.model || '').trim();
  const provider = String(settings && settings.provider || '').trim().toLowerCase();
  const models = Array.isArray(base.models) ? base.models : [];
  // 保存的模型只有在当前目录里仍然存在（且 provider 对得上）时才作为默认值；
  // 否则回落到目录的首选（例如模型被上游下线后不至于把旧 id 送进网关）。
  const usable = Boolean(model && models.some((item) => (
    String(item && item.id || '').trim() === model
    && (!provider || String(item && item.provider || '').trim().toLowerCase() === provider)
  )));
  return {
    ...base,
    defaultModel: usable ? model : base.defaultModel,
    defaultProvider: usable ? provider : base.defaultProvider
  };
}

function resolveGatewayClientKey(ctx) {
  const options = (ctx && ctx.options) || {};
  return String(options.clientKey || (ctx && ctx.deps && ctx.deps.clientKey) || '').trim();
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function writeTranslationEvent(res, payload) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_error) {
    return false;
  }
}

async function handleStreamRequest(ctx) {
  const startedAt = Date.now();
  let body = null;
  try {
    body = await readJsonBody(ctx);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }

  let text = '';
  let languages = null;
  let selection = null;
  const fsImpl = (ctx && ctx.fs) || require('node:fs');
  let savedSettings = null;
  try {
    savedSettings = readTranslationSettings(fsImpl, resolveAiHomeDir(ctx), (ctx && ctx.deps) || {});
  } catch (_error) {
    savedSettings = null;
  }
  const catalog = buildTranslationModelCatalog(ctx);
  // 保存的模型/供应商才是翻译的默认值；catalog.defaultModel 只是「从未设置过」时的兜底。
  // 之前这里只看 catalog，导致不带 model 的请求（页面刚打开、浮层先于设置加载）会落到
  // 目录里第一个模型 claude-opus-4-6-thinking，一次 hello world 也要先思考数秒。
  const fallbackCatalog = resolveTranslationFallbackCatalog(catalog, savedSettings);
  try {
    text = normalizeTextLimit(body && body.text);
    if (!text.trim()) throw createRouteError(400, 'translation_text_required', '请输入要翻译的内容');
    languages = resolveRequestLanguages(body);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }

  const detection = detectLanguage(text);
  const resolvedSource = languages.source === AUTO_LANGUAGE
    ? (detection.code || '')
    : languages.source;
  // 源语言与目标语言相同：不消耗模型额度、不产生翻译记录。auto 时以检测结果为权威，
  // 检测未知（空 code）时照常翻译，避免把无法判断的文本误跳过。放在模型解析之前，
  // 这样同语言请求不会因为「当前没有可用模型」而报成 409。
  if (resolvedSource && resolvedSource === languages.target) {
    writeError(
      ctx,
      createRouteError(400, 'translation_same_language', '源语言与目标语言相同，无需翻译')
    );
    return true;
  }

  try {
    selection = resolveRequestModel(body, fallbackCatalog);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }

  const prompt = buildTranslationMessages({
    text,
    source: languages.source,
    target: languages.target,
    glossary: body && body.glossary,
    formality: body && body.formality
  });

  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  let replyText = '';
  const emit = (event) => {
    if (closed) return;
    if (event.type === 'delta') replyText += String(event.content || '');
    writeTranslationEvent(res, event);
  };
  const onClose = () => { closed = true; };
  if (ctx.req && typeof ctx.req.on === 'function') {
    ctx.req.on('close', onClose);
    ctx.req.on('aborted', onClose);
  }

  emit({
    type: 'start',
    from: resolvedSource,
    fromLabel: resolvedSource ? languageLabel(resolvedSource) : '',
    detected: detection.code,
    detectedLabel: detection.label,
    detectionConfidence: detection.confidence,
    to: languages.target,
    toLabel: languageLabel(languages.target),
    model: selection.model,
    provider: selection.provider
  });

  const options = {
    port: (ctx.options && ctx.options.port) || undefined,
    clientKey: resolveGatewayClientKey(ctx),
    provider: selection.provider,
    timeoutMs: ctx.options && ctx.options.translationFirstByteTimeoutMs
  };
  const result = await runTranslationStream({
    model: selection.model,
    provider: selection.provider,
    // 同一 provider/模型固定一个会话键：账号亲和会复用上一次成功账号，避免每次
    // 翻译在 7 个 agy 账号之间轮换、反复命中冷启动。目标语言不参与键，启动预热
    // 才能和真实请求落在同一个账号上。
    sessionKey: `aih-translation:${selection.provider || 'auto'}:${selection.model}`,
    messages: prompt.messages
  }, options, emit);

  if (!closed) {
    if (result.ok) {
      emit({
        type: 'done',
        text: replyText,
        usage: result.usage || null,
        elapsedMs: Date.now() - startedAt
      });
    } else {
      emit({
        type: 'error',
        code: String(result.error && result.error.code || 'translation_failed'),
        message: String(result.error && result.error.message || '翻译失败'),
        status: Number(result.error && result.error.status) || 0,
        partialText: replyText,
        elapsedMs: Date.now() - startedAt
      });
    }
  }
  if (ctx.req && typeof ctx.req.removeListener === 'function') {
    ctx.req.removeListener('close', onClose);
    ctx.req.removeListener('aborted', onClose);
  }
  if (!res.writableEnded) res.end();
  return true;
}

async function handleSettingsRequest(ctx) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeError(ctx, createRouteError(503, 'translation_home_dir_unavailable', '数据目录不可用'));
    return true;
  }
  const fsImpl = (ctx && ctx.fs) || require('node:fs');
  const deps = (ctx && ctx.deps) || {};
  if (ctx.method === 'GET') {
    let settings = null;
    try {
      settings = readTranslationSettings(fsImpl, aiHomeDir, deps);
    } catch (_error) {
      settings = null;
    }
    const catalog = buildTranslationModelCatalog(ctx);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      settings: settings || {
        source: AUTO_LANGUAGE,
        target: 'zh-Hans',
        model: '',
        provider: '',
        updatedAt: 0
      },
      autoDetectedModel: catalog.defaultModel,
      autoDetectedProvider: catalog.defaultProvider
    });
    return true;
  }
  let body = null;
  try {
    body = await readJsonBody(ctx, 64 * 1024);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }
  // 只接受已知字段：写接口不是通用 KV，未知键直接忽略。
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'source')) {
    const code = normalizeLanguageCode(body.source);
    if (code !== AUTO_LANGUAGE && !isSupportedLanguage(code)) {
      writeError(ctx, createRouteError(400, 'translation_source_unsupported', '源语言不受支持'));
      return true;
    }
    patch.source = code || AUTO_LANGUAGE;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'target')) {
    const code = normalizeLanguageCode(body.target);
    if (!isSupportedLanguage(code)) {
      writeError(ctx, createRouteError(400, 'translation_target_unsupported', '目标语言不受支持'));
      return true;
    }
    patch.target = code;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'model')) {
    patch.model = String(body.model || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, 'provider')) {
    patch.provider = String(body.provider || '').trim().toLowerCase();
  }
  try {
    const settings = writeTranslationSettings(fsImpl, aiHomeDir, patch, deps);
    ctx.writeJson(ctx.res, 200, { ok: true, settings });
  } catch (error) {
    writeError(ctx, createRouteError(500, String(error && error.message || 'translation_settings_write_failed'), '保存翻译设置失败'));
  }
  return true;
}

function handleLanguagesRequest(ctx) {
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    languages: listLanguages(),
    auto: AUTO_LANGUAGE
  });
  return true;
}

async function handleDetectRequest(ctx) {
  let body = null;
  try {
    body = await readJsonBody(ctx, 64 * 1024);
  } catch (error) {
    writeError(ctx, error);
    return true;
  }
  const text = String(body && body.text || '').slice(0, 4000);
  const detection = detectLanguage(text);
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    code: detection.code,
    label: detection.label,
    confidence: detection.confidence,
    script: detection.script
  });
  return true;
}

function handleModelsRequest(ctx) {
  const catalog = buildTranslationModelCatalog(ctx);
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    models: catalog.models,
    defaultModel: catalog.defaultModel,
    defaultProvider: catalog.defaultProvider
  });
  return true;
}

/**
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleWebUiTranslationRoutes(ctx) {
  const { method, pathname } = ctx;
  if (!String(pathname || '').startsWith(TRANSLATION_BASE_PATH)) return false;
  const subPath = pathname.slice(TRANSLATION_BASE_PATH.length) || '/';

  try {
    if (method === 'GET' && subPath === '/settings') return handleSettingsRequest(ctx);
    if (method === 'POST' && subPath === '/settings') return handleSettingsRequest(ctx);
    if (method === 'GET' && subPath === '/languages') return handleLanguagesRequest(ctx);
    if (method === 'POST' && subPath === '/detect') return handleDetectRequest(ctx);
    if (method === 'GET' && subPath === '/models') return handleModelsRequest(ctx);
    if (method === 'POST' && subPath === '/stream') return handleStreamRequest(ctx);
  } catch (error) {
    if (!ctx.res.headersSent) {
      writeError(ctx, error);
    } else if (!ctx.res.writableEnded) {
      ctx.res.end();
    }
    return true;
  }
  ctx.writeJson(ctx.res, 404, { ok: false, error: 'translation_route_not_found' });
  return true;
}

// 启动预热：模型目录的首次构建实测约 0.9s（能力索引扫描全部账号与模型）。让它在
// listen 之前完成，第一个打开翻译页的请求才不需要为目录构建付费。
// 启动预热：只构建模型目录不需要网络。翻译的**第一个真实请求**还要初始化上游账号会话
// （agy code-assist 冷启动实测 7–13s），因此另做一个极小的后台请求，把保存的模型所在
// 账号提前焐热。它不写 SSE、不展示结果，失败也完全静默；每进程最多一次。
let translationGatewayWarmup = {
  key: '',
  at: 0,
  inFlight: false
};
function warmTranslationGateway(ctx) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) return;
  const fsImpl = (ctx && ctx.fs) || require('node:fs');
  let settings = null;
  try {
    settings = readTranslationSettings(fsImpl, aiHomeDir, (ctx && ctx.deps) || {});
  } catch (_error) {
    settings = null;
  }
  const model = String(settings && settings.model || '').trim();
  const provider = String(settings && settings.provider || '').trim().toLowerCase();
  const port = Number(ctx && ctx.options && ctx.options.port);
  const clientKey = resolveGatewayClientKey(ctx);
  if (!model || !provider || !Number.isFinite(port) || port <= 0 || !clientKey) return;

  const key = `${provider}:${model}`;
  const now = Date.now();
  if (translationGatewayWarmup.inFlight) return;
  if (translationGatewayWarmup.key === key && now - translationGatewayWarmup.at < 10 * 60 * 1000) return;

  translationGatewayWarmup = { key, at: now, inFlight: true };
  const finish = () => {
    translationGatewayWarmup.inFlight = false;
    translationGatewayWarmup.at = Date.now();
  };
  void runTranslationStream({
    model,
    provider,
    sessionKey: `aih-translation:${provider}:${model}`,
    maxTokens: 64,
    messages: [{ role: 'user', content: 'ping' }]
  }, {
    port,
    clientKey,
    provider,
    timeoutMs: 30_000
  }, () => {}).catch(() => null).finally(finish);
}

function warmTranslationModelCatalog(ctx) {
  return buildTranslationModelCatalog(ctx);
}

module.exports = {
  TRANSLATION_BASE_PATH,
  MAX_TRANSLATION_INPUT_CHARS,
  handleWebUiTranslationRoutes,
  buildTranslationModelCatalog,
  warmTranslationGateway,
  warmTranslationModelCatalog,
  __private: {
    readJsonBody,
    resolveRequestLanguages,
    resolveRequestModel,
    resolveTranslationFallbackCatalog,
    translationDefaultScore,
    resolveAiHomeDir,
    writeTranslationEvent
  }
};
