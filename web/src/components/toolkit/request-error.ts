/** Toolkit 请求错误文案：优先服务端 message / error，其次异常自身 message，最后回落到调用方文案。 */
export function toolkitRequestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as {
      response?: { data?: { message?: string; error?: string } };
      message?: string;
    };
    return candidate.response?.data?.message
      || candidate.response?.data?.error
      || candidate.message
      || fallback;
  }
  return fallback;
}
