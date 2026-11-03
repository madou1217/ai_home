export type BrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function normalizeBrowserUrl(input: string): BrowserUrlResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: '请输入网址' };
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: '仅支持 http 和 https 地址' };
    }
    parsed.username = '';
    parsed.password = '';
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: '网址格式无效' };
  }
}
