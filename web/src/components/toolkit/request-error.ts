/** 从服务端错误体里取可读文案：既支持字符串，也支持 `{ code, message }` 形式的对象。 */
function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as { message?: unknown; error?: unknown; code?: unknown };
  return errorMessage(record.message)
    || errorMessage(record.error)
    || (typeof record.code === 'string' ? record.code : '');
}

/**
 * Toolkit 请求错误文案：优先服务端 message / error，其次异常自身 message，最后回落到调用方文案。
 *
 * 服务端的 404 等错误体是 `{"error":{"code","message"}}`；必须归一成字符串再交给 React，
 * 否则对象会被当成 children 渲染，触发 React #31 并拖垮整个页面。
 */
export function toolkitRequestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as {
      response?: { data?: { message?: unknown; error?: unknown } };
      message?: unknown;
    };
    return errorMessage(candidate.response?.data)
      || errorMessage(candidate.message)
      || fallback;
  }
  return fallback;
}
