import { message } from 'antd';

export function getErrorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string; error?: string } };
  };
  return candidate?.response?.data?.message
    || candidate?.response?.data?.error
    || candidate?.message
    || fallback;
}

export function isMutationApplied(result: { ok: boolean; applied?: boolean }) {
  return result.ok && result.applied === true;
}

export function getMutationMessage(
  result: { error?: string; message?: string; warnings?: string[] },
  fallback: string
) {
  return result.message || result.error || result.warnings?.join('；') || fallback;
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function copyText(value: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(successMessage);
  } catch {
    message.error('无法访问剪贴板，请手动复制');
  }
}

export function formatLastSynced(timestamp: number | null) {
  if (!timestamp) return '尚未同步';
  return new Date(timestamp).toLocaleString();
}
