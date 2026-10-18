'use strict';

// kiro 的**纯 HTTP 模型清单**。两代端点（2026-10-18 实测）：
//
//   * V3（控制面，**真实按套餐**）：POST https://management.<region>.kiro.dev/
//       x-amz-target: KiroControlPlaneBearerService.ListAvailableModels
//       body `{"origin":"KIRO_CLI","profileArn":"<arn>"}`（**必须带 profileArn**，否则 400）
//       → FREE 返回 8 个、PRO+ 返回 21 个（含 claude-opus-5.5 / gpt-5.6-* 等）。这就是官方
//         kiro-cli `chat --list-models` 用的那条，**正确反映账号的套餐**。
//   * V2（旧，codewhisperer.<region>.amazonaws.com）：AmazonCodeWhispererService.ListAvailableModels
//       body `{"origin":"CLI"}` → **对所有套餐都只返回 3 个**（claude-sonnet-4.5 / -4 / haiku-4.5）。
//       V2 不认 profileArn，只作兜底（企业多 profile 无法选、或 V3 不可用时）。
//
// 两代响应形状相同：`{ defaultModel: { modelId }, models: [{ modelId, modelName, … }] }`，
// 因此 collectModelIds 两边通用。推理端点（V2 streaming）忽略 modelId（恒走 auto），
// 所以列 V3 全量模型不会让任何一支变得不可调用。

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10000;

function catalogError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function collectModelIds(document) {
  const ids = new Set();
  const push = (value) => {
    const id = String(value || '').trim();
    if (id) ids.add(id);
  };
  const list = Array.isArray(document && document.models) ? document.models : [];
  for (const model of list) {
    push(model && (model.modelId || model.model_id || model.modelName || model.model_name));
  }
  // 默认模型不总在 models 列表里，单独补一次，避免漏掉账号实际默认使用的那一支。
  const defaultModel = document && document.defaultModel;
  push(defaultModel && (defaultModel.modelId || defaultModel.model_id || defaultModel.modelName));
  return [...ids].sort();
}

function resolveKiroRegion(auth) {
  const region = String(auth && auth.region || '').trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : 'us-east-1';
}

/** 一次 ListAvailableModels 请求 + 解析（两代端点共用，只有 url/target/body 不同）。 */
async function requestKiroModels(url, target, body, accessToken, options = {}) {
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw catalogError('kiro_models_transport_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': target
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response || response.status !== 200) {
      throw catalogError(`kiro_models_http_${response && response.status ? response.status : 'failed'}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw catalogError('kiro_models_response_too_large');
    let document = null;
    try {
      document = JSON.parse(text);
    } catch (_error) {
      throw catalogError('kiro_models_invalid_json');
    }
    const models = collectModelIds(document);
    if (models.length === 0) throw catalogError('kiro_models_empty_catalog');
    return {
      models,
      defaultModel: String(document && document.defaultModel && document.defaultModel.modelId || '').trim(),
      status: response.status
    };
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('kiro_models_')) throw error;
    throw catalogError(controller.signal.aborted ? 'kiro_models_timeout' : 'kiro_models_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}

/** V2（旧）：对所有套餐只返回 3 个。不认 profileArn，仅作兜底。 */
async function fetchKiroAvailableModelsV2(auth, options = {}) {
  const accessToken = String(auth && (auth.access_token || auth.accessToken) || '').trim();
  if (!accessToken) throw catalogError('kiro_models_missing_access_token');
  return requestKiroModels(
    `https://codewhisperer.${resolveKiroRegion(auth)}.amazonaws.com/`,
    'AmazonCodeWhispererService.ListAvailableModels',
    { origin: 'CLI' },
    accessToken,
    options
  );
}

/** V3（控制面）：按套餐返回真实清单（FREE 8 / PRO+ 21）。**必须**带 profileArn。 */
async function fetchKiroAvailableModelsV3(auth, profileArn, options = {}) {
  const accessToken = String(auth && (auth.access_token || auth.accessToken) || '').trim();
  if (!accessToken) throw catalogError('kiro_models_missing_access_token');
  const arn = String(profileArn || '').trim();
  if (!arn) throw catalogError('kiro_models_missing_profile_arn');
  return requestKiroModels(
    `https://management.${resolveKiroRegion(auth)}.kiro.dev/`,
    'KiroControlPlaneBearerService.ListAvailableModels',
    { origin: 'KIRO_CLI', profileArn: arn },
    accessToken,
    options
  );
}

/**
 * 拉取该账号可用的模型 ID 清单（纯 HTTP）。
 *
 * 带 profileArn → 走 V3（真实套餐清单），失败再回落 V2；不带 → 只走 V2（旧调用方/测试口径）。
 *
 * @returns {Promise<{models: string[], defaultModel: string, status: number}>}
 */
async function fetchKiroAvailableModels(auth, options = {}) {
  const profileArn = String(options.profileArn || '').trim();
  if (!profileArn) return fetchKiroAvailableModelsV2(auth, options);
  try {
    return await fetchKiroAvailableModelsV3(auth, profileArn, options);
  } catch (error) {
    // V3 不可用（端点抖动 / 未知 profile 等）不该让账号变「无模型」：回落旧端点的 3 个。
    const v2 = await fetchKiroAvailableModelsV2(auth, options);
    return { ...v2, fallbackFrom: (error && error.code) || 'kiro_models_v3_failed' };
  }
}

module.exports = {
  collectModelIds,
  fetchKiroAvailableModels,
  fetchKiroAvailableModelsV2,
  fetchKiroAvailableModelsV3
};
