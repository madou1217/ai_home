'use strict';

// 只接受 POST 的推理端点收到 GET/HEAD 时在本地回 405，不转发上游。
//
// 曾经的事故：一个无正文的 GET /v1/messages 按默认 provider 落到 codex，被拼成上游
// chatgpt.com/backend-api/codex/messages，Cloudflare 回 403，又被误判成凭据失效锁号。
// 这些路径没有 GET 语义，转发出去只会制造上游噪声和误判。OPTIONS 不拦（保留预检）。
const POST_ONLY_INFERENCE_PATHS = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/chat/completions',
  '/v1/responses'
]);

function rejectNonPostInference({ method, pathname, res, writeJson }) {
  const verb = String(method || '').toUpperCase();
  if ((verb !== 'GET' && verb !== 'HEAD') || !POST_ONLY_INFERENCE_PATHS.has(pathname)) return false;
  res.setHeader('Allow', 'POST');
  writeJson(res, 405, { ok: false, error: 'method_not_allowed', allowed: ['POST'] });
  return true;
}

module.exports = { POST_ONLY_INFERENCE_PATHS, rejectNonPostInference };
