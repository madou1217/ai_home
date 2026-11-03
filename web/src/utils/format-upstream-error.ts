// 把上游/网关返回的裸错误串（多为 `HTTP 500 {"error":{"message":"..."}}`）拆成
// 结构化片段，避免把原始 JSON 直接糊给用户。全站错误展示统一走这里。
export interface ParsedUpstreamError {
  /** HTTP 状态码（若能识别），如 "500" */
  statusCode: string;
  /** 人类可读的错误消息（已剥离 JSON 包裹与尾随的 issue 链接文案） */
  message: string;
  /** 错误文案里出现的第一个 URL（通常是上游 issue 链接） */
  url: string;
  /** 原始错误串，供「复制原始错误」使用 */
  raw: string;
}

export function parseUpstreamError(raw: string): ParsedUpstreamError {
  const text = String(raw || '').trim();
  const httpMatch = text.match(/HTTP\s+(\d{3})/i);
  const statusCode = httpMatch ? httpMatch[1] : '';
  let body = httpMatch ? text.slice(text.indexOf(httpMatch[0]) + httpMatch[0].length).trim() : text;
  const jsonStart = body.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(body.slice(jsonStart));
      body = String(parsed?.error?.message || parsed?.message || parsed?.error?.code || parsed?.error || body);
    } catch {
      // 非合法 JSON，保留原串
    }
  }
  let url = '';
  const urlMatch = body.match(/https?:\/\/[^\s"')]+/);
  if (urlMatch) {
    url = urlMatch[0];
    body = body.replace(urlMatch[0], '').replace(/[，,]?\s*(please\s+submit\s+a?\s*issue\s+here)\s*[:：]?\s*$/i, '').trim();
  }
  return { statusCode, message: body || text, url, raw: text };
}
