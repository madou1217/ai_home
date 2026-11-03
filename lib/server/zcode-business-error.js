'use strict';

// 智谱 / Z.ai（zcode）家族把业务失败放在 **HTTP 200** 的响应体里，而不是错误状态码：
//
//   HTTP/1.1 200 OK
//   content-type: application/json    content-length: 40
//   {"code":1005,"msg":"exceed quota limit"}
//
// 实测证据（2026-08-22 12:37:52Z，requestId b4fc7d4e-f48b-49b6-8276-7853df57af8e，
// providerId builtin:zai-start-plan，responseStatus=200）：同一账号的
// billing/balance 当时仍报 remaining_units=74,081,782 / total_units=100,000,000
// （period=one_time，无日限/无 5h 窗口字段），上游依然以该信封拒绝。
// 也就是说 1005 是**上游准入判定**，用的维度没有在 balance 接口暴露；
// 本地余额快照并没有算错，不能靠改展示或放宽本地判断来「修好」。
//
// 网关侧真正的缺陷在于：upstream-endpoints-transport-general 只用
// `status >= 400` 判定成败，于是这类拒绝被当成**成功**放行——不记失败、不熔断、
// 不换账号，客户端拿到一段无法解析的 JSON。本模块只负责把这个信封识别出来，
// 让它走与 4xx/5xx 完全相同的既有失败路径。
//
// 只认上游明确给出的结构化业务码，不做人类可读文案推断，与
// upstream-failure-policy「Never infer this classification from human-readable
// text」的既有约定保持一致。

// 智谱家族的「额度/配额被拒」业务码。
const ZCODE_QUOTA_BUSINESS_CODE = 1005;

// 智谱家族的「没有可用资源包 / 余额不足」业务码（HTTP 429 信封）：
//   {"type":"error","error":{"type":"rate_limit_error","code":"1113",
//    "message":"[1113][Insufficient balance or no resource package. Please recharge.]"}}
// 真机（2026-10-27）：账号**有**活跃 Start Plan 套餐（billing/balance 里
// entitlements 带 grant_units）时，ultra 端点仍回 1113 —— 它描述的是
// 「该端点/该凭据形态下没有可消耗的资源包」，属**账号级**不可用，
// 不是 5 分钟能自愈的限流（此前被判成 rate_limited）。
const ZCODE_NO_PACKAGE_BUSINESS_CODE = 1113;

// 智谱家族的「在飞并发上限」业务码（HTTP 429 信封）：ZCode 对单账号/单模型只允许
// 少数请求同时在飞，超了回 3008（user concurrency limit exceeded）/
// 3009（model concurrency limit exceeded）——**这不是额度用完，也不是限流**，
// 而是「还没轮到你这个请求」。
//
// 真机（2026-10-27，本机唯一有套餐的账号）：`glm-5.3` 连续回 3009，说明
// **凭据、端点、套餐三者都被上游接受**（否则会是 1005 无套餐 / 401 凭据错 /
// 3012 拦截），只是并发槽被占。此前我们把它判成 rate_limited（5 分钟冷却 +
// 账号级记账），等于给一个健康账号挂冷却，并把「并发上限」错报成「限流」。
const ZCODE_BUSY_BUSINESS_CODES = Object.freeze([3008, 3009]);

// 智谱家族的「请求被节流/风控」业务码（HTTP 405 信封）：
//   {"code":3012,"msg":"request has been blocked due to unusual activity."}
// 真机（2026-10-27，唯一有套餐的账号，逐项排除法）：
//   * 端点 = 官方客户端自己的那个（`${origin}/api/v1/zcode-plan/anthropic`，
//     见 CLI bundle 与 Desktop app.asar）；
//   * 凭据 = 单头 `Authorization: Bearer <zcodejwttoken>`（桌面端 start-plan 的形态）；
//   * 请求形态：最小 body / **ZCode 真实形态**（system 三块内容取自本机 3.16.3
//     bundle 的 harness/communicating/context 段 + cliPrefix + <system-reminder>
//     日期轮 + metadata.user_id + ZCode 全部头）× stream/non-stream × 大小写模型名，
//     逐字相同地回 3012；
//   * **按模型分**：同一时刻 `glm-5.3` 回 3009（并发上限，说明账号可用）而
//     `glm-5.3-flash` 回 3012；连打若干次后 `glm-5.3` 也被升到 3012。
//   → 结论：它是**按 (账号, 模型) 的节流/风控信号**，由短时间内重复请求触发，
//     不是「账号被封」。因此不能按账号级长休息处理（那会把一个能服务别的模型的
//     账号整天摘出池子），也不该写成 auth_invalid（重新登录解决不了节流）。
const ZCODE_THROTTLE_BUSINESS_CODE = 3012;

// balance/探测域的「成功」业务码集合（实测成功回包是 code:0；200 是历史防御性接受）。
// 与推理域为何不同见文件尾「两域判错规则」——不要顺手统一。
const ZCODE_BALANCE_SUCCESS_CODES = Object.freeze([0, 200, '0', '200']);
// balance/探测域的「参数错误」细分码（探测层把它的报错文案与一般业务失败分开）。
const ZCODE_BALANCE_PARAMETER_ERROR_CODE = '3001';

// 正常回包的载荷键：出现其一即视为正常响应，绝不当作业务错误。
// Anthropic messages 用 content，OpenAI chat completions 用 choices。
const PAYLOAD_KEYS = Object.freeze(['choices', 'content']);

function toPlainObject(body) {
  if (Buffer.isBuffer(body)) return toPlainObject(body.toString('utf8'));
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text || text[0] !== '{') return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function toBusinessCode(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * 解析 zcode 家族承载在 2xx 里的业务错误信封。
 * 命中条件刻意收窄：顶层必须同时有非 0 数字 code 与非空字符串 msg，
 * 且不带任何正常回包的载荷键——避免把健康响应误判成失败。
 *
 * @param {Buffer|string|object} body 上游响应体
 * @returns {{code: number, message: string}|null}
 */
function parseZcodeBusinessError(body) {
  const source = toPlainObject(body);
  if (!source) return null;
  for (const key of PAYLOAD_KEYS) {
    if (source[key] !== undefined) return null;
  }
  const code = toBusinessCode(source.code);
  if (code === null || code === 0) return null;
  const message = typeof source.msg === 'string' ? source.msg.trim() : '';
  if (!message) return null;
  return { code, message };
}

/**
 * 判定一次「传输层看起来成功」的上游响应是否其实是业务失败。
 *
 * 通用传输层只按状态码判定成败，不该内联任何 provider 私有知识；
 * 「2xx 里是否藏着失败」这条规则属于 provider，由本模块单独持有。
 * 状态码 >= 400 一律返回 null：那条路径已有既定处理，不在这里重复判定。
 *
 * @param {{provider?: string, statusCode?: number, body?: Buffer|string|object}} input
 * @returns {{code: number, message: string}|null}
 */
function detectUpstreamBusinessFailure(input = {}) {
  const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  if (provider !== 'zcode') return null;
  if (Number(input.statusCode) >= 400) return null;
  return parseZcodeBusinessError(input.body);
}

/**
 * balance/探测域：判定 {code,msg,success} 信封是否为成功。
 * 规则：success === false 一律失败；code 缺省或在成功码集合内视为成功。
 * （推理域不适用本判定——见 parseZcodeBusinessError 的载荷键守卫。）
 */
function isZcodeBalanceEnvelopeOk(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  if (envelope.success === false) return false;
  if (envelope.code === undefined) return true;
  return ZCODE_BALANCE_SUCCESS_CODES.includes(envelope.code);
}

/** balance/探测域：把信封压成「code msg」详情串（两处探测的既有格式，逐字保持）。 */
function describeZcodeBalanceEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return '';
  return [
    envelope.code === undefined ? '' : String(envelope.code).trim(),
    String(envelope.msg || envelope.message || '').trim()
  ].filter(Boolean).join(' ');
}

/** balance/探测域：3001 是参数错误，探测层用它区分报错文案。 */
function isZcodeBalanceParameterErrorCode(code) {
  return String(code ?? '').trim() === ZCODE_BALANCE_PARAMETER_ERROR_CODE;
}

module.exports = {
  ZCODE_QUOTA_BUSINESS_CODE,
  ZCODE_NO_PACKAGE_BUSINESS_CODE,
  ZCODE_BUSY_BUSINESS_CODES,
  ZCODE_THROTTLE_BUSINESS_CODE,
  ZCODE_BALANCE_SUCCESS_CODES,
  ZCODE_BALANCE_PARAMETER_ERROR_CODE,
  parseZcodeBusinessError,
  detectUpstreamBusinessFailure,
  isZcodeBalanceEnvelopeOk,
  describeZcodeBalanceEnvelope,
  isZcodeBalanceParameterErrorCode
};

// ── 两域判错规则（2026-10-06 收敛定稿，改动前先读这里）─────────────────────
//
// 同一个 {code,msg,success} 信封结构在两个域里语义不同，差异来自**载荷语义**：
//
// balance/探测域（billing/balance、paas models 探测）：
//   成功 = success !== false 且 code ∈ {0,200,'0','200'}（成功回包带 data 载荷，
//   由各调用方另行校验 data.balances / data 数组）。失败时 3001 细分为参数错误。
//
// 推理域（网关透传的 messages/chat 回包）：
//   成功 = 响应体带载荷键（choices/content）。无载荷键时，数字 code≠0 且 msg
//   非空即业务失败。{code:200,msg:"x"} 在推理域按失败处理：客户端没有任何可
//   消费载荷，转发只会制造幽灵成功；而 balance 域 code:200 是防御性接受的历史
//   成功码。两域不共享成功码集合，是有意为之。
