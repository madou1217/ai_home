'use strict';

/**
 * 上游真实失败的「留档 / 重放」。
 *
 * 背景：账号池里只剩一个可用账号时，一次真实的上游 429 会先按 (账号,模型) 打冷却，
 * 然后请求编排器换下一个账号；此时池子已经空了，编排器给出 no_account，调用方于是
 * 合成 503 no_available_account。客户端看到的是「没有可调度的账号」，而真相是上游限流——
 * 真实状态码被洗掉了。
 *
 * 这个模块只负责一件事：把本次请求中最后一次真实的上游 HTTP 失败原样记下来；
 * 编排结束后若没有任何账号成功，就把上游说过的话还给客户端。
 * 不碰冷却策略（冷却本身是对的），只修「对外怎么讲」。
 */

/**
 * 读上游的 retry-after。
 * 走 JSON 兜底写法时上游响应头会整体丢掉，而限流场景里这个头正是客户端退避的唯一依据，
 * 必须单独留下来。
 */
function readUpstreamRetryAfter(upstreamRes) {
  var headers = upstreamRes && upstreamRes.headers;
  if (!headers || typeof headers.get !== 'function') return '';
  return String(headers.get('retry-after') || '').trim();
}

/**
 * 创建一次请求作用域的失败留档器。
 * 只保留最后一次真实 HTTP 失败：网络层异常不进这里，那条路径已有自己的状态码。
 */
function createUpstreamFailureRecorder() {
  var recorded = null;
  return {
    record: function record(entry) {
      if (!entry || !Number.isFinite(Number(entry.statusCode))) return;
      recorded = {
        statusCode: Number(entry.statusCode),
        upstreamRes: entry.upstreamRes || null,
        raw: Buffer.isBuffer(entry.raw) ? entry.raw : null,
        account: entry.account || null,
        streamRequested: entry.streamRequested === true,
        passthrough: entry.passthrough === true,
        retryAfter: readUpstreamRetryAfter(entry.upstreamRes),
        error: String(entry.error || 'upstream_failed'),
        detail: String(entry.detail || '')
      };
    },
    get: function get() {
      return recorded;
    }
  };
}

/**
 * 把留档的上游失败写回客户端。
 *
 * 写法完全对齐「直接失败」分支：策略允许透传且有响应体时原样透传，否则用统一的
 * upstream_failed JSON。写出方式由调用方注入，避免这里反向依赖 upstream-endpoints。
 *
 * @returns {boolean} 是否真的写出了响应
 */
function writeUpstreamFailureReplay(res, replay, deps = {}) {
  if (!replay || !res || res.headersSent || res.writableEnded) return false;
  var sendRawUpstreamResponse = typeof deps.sendRawUpstreamResponse === 'function'
    ? deps.sendRawUpstreamResponse
    : null;
  var writeJson = typeof deps.writeJson === 'function' ? deps.writeJson : null;
  if (replay.passthrough && replay.upstreamRes && replay.raw && replay.raw.length > 0 && sendRawUpstreamResponse) {
    sendRawUpstreamResponse(res, replay.upstreamRes, replay.raw, replay.account || {}, replay.streamRequested);
    return true;
  }
  if (!writeJson) return false;
  // JSON 兜底会丢掉上游响应头，retry-after 必须补回去，否则客户端拿到 429 也不知道等多久。
  if (replay.retryAfter && typeof res.setHeader === 'function') {
    res.setHeader('retry-after', replay.retryAfter);
  }
  writeJson(res, replay.statusCode, {
    ok: false,
    error: replay.error || 'upstream_failed',
    detail: replay.detail || ''
  });
  return true;
}

/**
 * 写「无可用账号」响应：真的没打过上游时才走这里。
 *
 * 当所有账号都只是被限流冷却时，classifyNoAvailableAccountResponse 会给出 429 + retryAt，
 * 这里把它翻成标准的 Retry-After 头，客户端（codex/claude CLI 等）才能按限流语义退避，
 * 而不是把它当成网关不可用。
 */
function writeUnavailableAccountResponse(res, writeJson, unavailable) {
  if (!res || typeof writeJson !== 'function' || !unavailable) return false;
  var retryAfterSeconds = Number(unavailable.retryAfterSeconds);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && typeof res.setHeader === 'function') {
    res.setHeader('retry-after', String(Math.ceil(retryAfterSeconds)));
  }
  writeJson(res, unavailable.statusCode, unavailable.payload);
  return true;
}

module.exports = {
  createUpstreamFailureRecorder,
  writeUnavailableAccountResponse,
  writeUpstreamFailureReplay
};
