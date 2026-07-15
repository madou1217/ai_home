import { isNativeDesktopRuntime } from './native-server-profile-repository';

function normalizeExternalUrl(value: string) {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    throw new Error('invalid_external_url');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid_external_url');
  }
  return url.toString();
}

export function isExternalHttpUrl(value?: string) {
  try {
    normalizeExternalUrl(String(value || ''));
    return true;
  } catch (_error) {
    return false;
  }
}

export async function openExternalUrl(value: string) {
  const url = normalizeExternalUrl(value);
  if (isNativeDesktopRuntime()) {
    const { open } = await import('@tauri-apps/api/shell');
    await open(url);
    return;
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) throw new Error('external_url_open_blocked');
  opened.opener = null;
}
