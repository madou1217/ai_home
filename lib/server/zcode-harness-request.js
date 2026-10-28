'use strict';

// ZCode plan 端点的**请求体整形成官方 harness 形态**（唯一实现处）。
//
// 上游准入判据在 body 的 `system`（真机二分，2026-10-28）：
//   * 最小 body（无 system）→ 405 code:3012 unusual activity；
//   * 官方 harness 两块（identity 行 + harness 段）→ 200；追加/删块/换文案 → 3012；
//   * `messages` / `tools` 不参与判定（非官方工具照过）。
// 因此 relay 必须让 plan 请求带上官方 harness，而**客户端自己的系统指令不能留在
// `system` 里**（实测：官方 harness + 追加一段客户端 system → 3012）。做法：
//   1) `system` 换成缓存的官方 harness（逐块原样，保留 cache_control）；
//   2) 客户端原本的 system 指令搬进 `messages`（`<system-reminder>` 形态的 user 消息，
//      实测该形态 200 出流）；
//   3) 补 `metadata.user_id`（官方形态：device_id / account_uuid / session_id）。
// 已经带官方 harness 的请求（例如官方客户端自己）**逐字节不变**。

const { extractZcodeHarnessBlocks } = require('./zcode-harness-store');

function systemToText(system) {
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  const parts = [];
  for (const block of system) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block.trim());
      continue;
    }
    const text = typeof (block && block.text) === 'string' ? block.text.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function buildUserIdMetadata(existing, input) {
  const sessionId = String(input.sessionId || '').trim();
  const deviceMid = String(input.deviceMid || '').trim();
  let current = null;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) current = existing;
  if (!current || (!current.device_id && !current.session_id)) {
    current = {
      device_id: deviceMid || (current && current.device_id) || '',
      account_uuid: (current && current.account_uuid) || '',
      session_id: sessionId || (current && current.session_id) || ''
    };
  }
  return JSON.stringify(current);
}

/**
 * 把 forwardBody 整形成官方 harness 形态；任何异常/前置不满足时**原样返回**（fail-soft）。
 *
 * @param {Buffer|string} forwardBody 已序列化的上游请求体
 * @param {object} input { harness: {blocks}, sessionId, deviceMid }
 * @returns {Buffer|string} 同一个类型（发生改写时是 Buffer）
 */
function applyZcodeHarnessSystemBuffer(forwardBody, input = {}) {
  const harnessBlocks = extractZcodeHarnessBlocks(input.harness && input.harness.blocks);
  if (!harnessBlocks) return forwardBody;
  const text = Buffer.isBuffer(forwardBody) ? forwardBody.toString('utf8') : String(forwardBody || '');
  if (!text.trim().startsWith('{')) return forwardBody;
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    return forwardBody;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return forwardBody;
  // 官方客户端自己的请求（已带 harness）不碰一个字节。
  if (extractZcodeHarnessBlocks(body.system)) return forwardBody;
  const clientSystemText = systemToText(body.system);
  const next = { ...body, system: harnessBlocks };
  if (clientSystemText) {
    const reminder = { role: 'user', content: `<system-reminder>\n${clientSystemText}\n</system-reminder>` };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    next.messages = [reminder, ...messages];
  }
  next.metadata = { ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}) };
  next.metadata.user_id = buildUserIdMetadata(body.metadata && body.metadata.user_id, input);
  return Buffer.from(JSON.stringify(next));
}

module.exports = {
  applyZcodeHarnessSystemBuffer,
  systemToText
};
