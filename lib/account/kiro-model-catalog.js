'use strict';

// kiro 的**纯 HTTP 模型清单**（AmazonCodeWhispererService.ListAvailableModels）。
//
// 实测（2026-10-15）：同一个 codewhisperer.<region>.amazonaws.com 端点 + Bearer access token，
// `x-amz-target: AmazonCodeWhispererService.ListAvailableModels`，body `{"origin":"CLI"}` →
// 200 `{ defaultModel: { modelId, modelName, … }, models: [...] }`。
//
// 这就是 `native_cli_model_discovery_cli_not_found` 的纯 API 出路：模型清单不需要本地 CLI。

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

/**
 * 拉取该账号可用的模型 ID 清单（纯 HTTP）。
 * @returns {Promise<{models: string[], defaultModel: string, status: number}>}
 */
async function fetchKiroAvailableModels(auth, options = {}) {
  const accessToken = String(auth && (auth.access_token || auth.accessToken) || '').trim();
  if (!accessToken) throw catalogError('kiro_models_missing_access_token');
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw catalogError('kiro_models_transport_unavailable');
  const region = /^[a-z]{2}-[a-z]+-\d$/.test(String(auth && auth.region || '')) ? String(auth.region) : 'us-east-1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || TIMEOUT_MS));
  timer.unref?.();
  try {
    const response = await request(`https://codewhisperer.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.ListAvailableModels'
      },
      body: JSON.stringify({ origin: 'CLI' }),
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

module.exports = {
  collectModelIds,
  fetchKiroAvailableModels
};
