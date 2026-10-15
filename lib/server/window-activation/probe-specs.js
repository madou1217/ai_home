'use strict';

// 窗口激活探测的 provider 规格注册表。
//
// 背景：部分 OAuth 账号（当前最典型是 Codex Plus）的限额按「滚动窗口」计算，
// 窗口只有在账号被真正使用时才会推进/刷新。长期不用的账号窗口不前进，下一次
// 使用仍然卡在旧窗口里。窗口激活调度器就靠这里描述的「极小探测」去定期使用它。
//
// 本文件是纯数据 + 查表：只描述「怎么发一个最小请求」，不解析响应、不判账号状态、
// 不碰任何调度逻辑（那些在 window-activation-scheduler.js）。
//
// 规格字段与 scripts/gateway-account-auth-smoke.js 的 PROVIDER_SPECS 保持一致，
// 便于两处对同一 provider 的探测语义不漂移：
//   path              探测 POST 的数据面路径：字符串，或 (model) => string（模型进 URL 的协议）
//   model             首选探测模型（也用于构造 body 的默认值）
//   modelCandidates   首选不可用时的有序回退模型
//   probeModelPattern 账号目录里一个都不命中时，用它挑一个同协议族的模型（正则源串）
//   outputTokenCap    期望的输出 token 上限（仅供上层参考）
//   responseShape     期望的响应形状（仅供上层参考）
//   windowMatch       能力识别参数：命中该窗口的 entry 视为「可推进的滚动窗口」
//   body              构造请求体 (model) => object（每次调用生成新对象，避免共享可变引用）
//
// 为什么模型不写死：探测只是「用一次账号」，而账号目录会随上游改名/上下线变化
// （2026-10-15 实测：codex 目录已无 gpt-5.4-mini，写死的模型让路由器直接 503 排除账号，
// 探测一次都没打到账号上）。因此模型在探测时从目标账号的模型目录解析，见 probe-model.js。
//
// 新增 provider：往 PROBE_SPECS 加一条即可，调度器与派发层无需改动。

const PROBE_SPECS = Object.freeze({
  codex: Object.freeze({
    provider: 'codex',
    path: '/v1/responses',
    model: 'gpt-5.4-mini',
    modelCandidates: Object.freeze([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-6.1-sol',
      'gpt-6-astra'
    ]),
    probeModelPattern: '^gpt-',
    outputTokenCap: 32,
    responseShape: 'openai.response',
    // Codex 的 5 小时窗口：Go 侧 limit_window_seconds=18000，快照 entry 为 300 分钟。
    windowMatch: Object.freeze({ windowMinutes: 300 }),
    body: (model = 'gpt-5.4-mini') => ({
      model,
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Reply exactly OK.' }]
      }],
      store: false,
      reasoning: { effort: 'low' },
      stream: false
    })
  }),
  // Antigravity（agy）的限额同样是滚动窗口，且只在账号被使用时推进；
  // 数据面是 Gemini 协议，模型写在 URL 里，因此 path 是 (model) => string。
  agy: Object.freeze({
    provider: 'agy',
    path: (model = 'gemini-2.5-flash') => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    model: 'gemini-2.5-flash',
    modelCandidates: Object.freeze([
      'gemini-2.5-flash-lite',
      'gemini-3-flash',
      'gemini-3-flash-agent',
      'gemini-3.5-flash-lite'
    ]),
    probeModelPattern: '^gemini-',
    outputTokenCap: 8,
    responseShape: 'gemini.generateContent',
    windowMatch: Object.freeze({ windowMinutes: 300 }),
    body: () => ({
      contents: [{ role: 'user', parts: [{ text: 'Reply exactly OK.' }] }],
      generationConfig: {
        maxOutputTokens: 8,
        temperature: 0,
        thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }
      }
    })
  })
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/**
 * @returns {object|null} 命中注册表的规格副本（顶层浅拷贝，body 仍是原函数）；未知 provider 返回 null。
 */
function getProbeSpec(provider) {
  const key = normalizeProvider(provider);
  const spec = key ? PROBE_SPECS[key] : null;
  return spec ? { ...spec } : null;
}

function listProbeProviders() {
  return Object.keys(PROBE_SPECS);
}

module.exports = {
  PROBE_SPECS,
  getProbeSpec,
  listProbeProviders
};
