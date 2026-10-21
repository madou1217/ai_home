'use strict';

// 会话运行期错误的**用户可读文案**（runtime.prewarm.failed / 运行时启动失败）。
//
// 为什么需要这一层：chat 模式的 harness 是 Codex app-server（网关客户端），所以**任何**
// provider 的会话（workbuddy / opencode / claude …）在 harness 启动失败时，底层抛出的
// 都是 `codex_*` 前缀的内部错误码。把它原样透到界面，用户会看到「workbuddy 会话报
// codex_app_server_rpc_error」这种归属错乱、无法行动的错误（2026-10-21 真机反馈）。
//
// 分工（与 diagnostic-sanitizer 同思路，但目标不同）：
// - `code` 仍是机器码，用于重试判定、日志检索与排障 —— 不动；
// - `message` 是本模块产出的用户文案，说明**发生了什么、和哪个 provider 有关**；
// - 未登记的码给一条通用兜底，绝不把裸码当正文。
//
// 新增错误码只加一行；不在别处写 if/else 分支。

const RUNTIME_START_FAILURE_PREFIXES = Object.freeze({
  codex_: 'codex'
});

/** 具体码 → 文案。键是完整码，未命中再看前缀表，最后走通用兜底。 */
const RUNTIME_FAILURE_COPY = Object.freeze({
  codex_app_server_rpc_error: '会话运行时（Codex harness）通信失败，本轮未开始',
  codex_app_server_closed: '会话运行时（Codex harness）进程已退出，本轮未开始',
  codex_app_server_spawn_failed: '无法启动会话运行时（Codex harness）',
  codex_app_server_ready_timeout: '会话运行时（Codex harness）启动超时',
  runtime_prewarm_failed: '会话运行时启动失败，本轮未开始'
});

const GENERIC_RUNTIME_FAILURE_COPY = '会话运行时启动失败，本轮未开始';

function normalizeCode(value) {
  return String(value || '').trim();
}

/**
 * 把运行期内部错误码翻成用户文案。
 *
 * @param {string} code 机器码（保持原样用于诊断）
 * @param {{ provider?: string }} [context] 会话所属 provider，用于把归属讲清楚
 * @returns {string} 面向用户的一句话；绝不返回裸码
 */
function describeRuntimeFailure(code, context = {}) {
  const normalized = normalizeCode(code);
  const provider = normalizeCode(context && context.provider);
  const base = RUNTIME_FAILURE_COPY[normalized]
    || (RUNTIME_START_FAILURE_PREFIXES[prefixOf(normalized)] ? '会话运行时启动失败，本轮未开始' : '')
    || GENERIC_RUNTIME_FAILURE_COPY;
  // 归属提示：harness 与推理 provider 不是一回事，说清楚免得用户以为是账号问题。
  return provider ? `${base}（${provider} 会话，运行时与账号无关）` : base;
}

function prefixOf(code) {
  const index = String(code || '').indexOf('_');
  return index > 0 ? `${code.slice(0, index)}_` : '';
}

module.exports = {
  RUNTIME_FAILURE_COPY,
  describeRuntimeFailure
};
