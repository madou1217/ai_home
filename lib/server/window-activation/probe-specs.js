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
//   path            探测 POST 的 /v1/* 数据面路径
//   model           探测使用的模型
//   outputTokenCap  期望的输出 token 上限（仅供上层参考）
//   responseShape   期望的响应形状（仅供上层参考）
//   windowMatch     能力识别参数：命中该窗口的 entry 视为「可推进的滚动窗口」
//   body            构造请求体（每次调用生成新对象，避免共享可变引用）
//
// 新增 provider：往 PROBE_SPECS 加一条即可，调度器无需改动。

const PROBE_SPECS = Object.freeze({
  codex: Object.freeze({
    provider: 'codex',
    path: '/v1/responses',
    model: 'gpt-5.4-mini',
    outputTokenCap: 32,
    responseShape: 'openai.response',
    // Codex 的 5 小时窗口：Go 侧 limit_window_seconds=18000，快照 entry 为 300 分钟。
    windowMatch: Object.freeze({ windowMinutes: 300 }),
    body: () => ({
      model: 'gpt-5.4-mini',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Reply exactly OK.' }]
      }],
      store: false,
      reasoning: { effort: 'low' },
      stream: false
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
