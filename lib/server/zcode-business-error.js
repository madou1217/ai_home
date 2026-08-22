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

module.exports = {
  ZCODE_QUOTA_BUSINESS_CODE,
  parseZcodeBusinessError,
  detectUpstreamBusinessFailure
};
