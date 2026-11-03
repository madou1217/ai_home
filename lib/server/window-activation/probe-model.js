'use strict';

// 探测模型的解析层：探测要用哪个模型，由「目标账号自己的模型目录」决定。
//
// 为什么必须有这一层：探测只是「用一次账号」，模型本身不重要，但**模型必须在该账号的
// 目录里**——否则网关的账号选择会把该账号当成「不支持这个模型」直接排除，探测请求在
// 路由层就被 503 挡掉，一次都没打到账号上（2026-10-15 实测：codex 目录已无
// gpt-5.4-mini，三个开了窗口激活的账号连续几轮全部 http_503，窗口当然不推进）。
//
// 解析顺序（纯数据驱动，没有 provider 名分支）：
//   1. spec.model            —— 首选
//   2. spec.modelCandidates  —— 有序回退
//   3. spec.probeModelPattern—— 目录里一个都不命中时，挑同协议族的第一个（字典序）
//   4. 都没有 → model 为空串，调用方跳过探测（outcome: no_probe_model）
//
// 账号目录未知（空集）时按 1 处理：宁可让上游/网关给出真实错误，也不假装知道目录。

function normalizeModelId(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toModelSet(accountModels) {
  if (accountModels instanceof Set) {
    return new Set([...accountModels].map(normalizeModelId).filter(Boolean));
  }
  if (Array.isArray(accountModels)) {
    return new Set(accountModels.map(normalizeModelId).filter(Boolean));
  }
  return new Set();
}

/**
 * @param {object} spec probe-specs 里的规格
 * @param {Iterable<string>|Set<string>|Array<string>|null} accountModels 目标账号可用的模型
 * @returns {{model: string, source: 'spec'|'candidate'|'pattern'|'unknown_catalog'|'unavailable'}}
 */
function resolveProbeModel(spec, accountModels) {
  const candidates = [spec && spec.model, ...((spec && spec.modelCandidates) || [])]
    .map(normalizeModelId)
    .filter(Boolean);
  const available = toModelSet(accountModels);

  if (available.size === 0) {
    return { model: candidates[0] || '', source: candidates.length > 0 ? 'unknown_catalog' : 'unavailable' };
  }

  const primary = normalizeModelId(spec && spec.model);
  if (primary && available.has(primary)) return { model: primary, source: 'spec' };
  for (const candidate of candidates) {
    if (available.has(candidate)) return { model: candidate, source: 'candidate' };
  }

  const patternSource = normalizeModelId(spec && spec.probeModelPattern);
  if (patternSource) {
    let pattern = null;
    try {
      pattern = new RegExp(patternSource);
    } catch (_patternError) {
      pattern = null;
    }
    if (pattern) {
      const matched = [...available].filter((model) => pattern.test(model)).sort();
      if (matched.length > 0) return { model: matched[0], source: 'pattern' };
    }
  }

  return { model: '', source: 'unavailable' };
}

module.exports = {
  resolveProbeModel
};
