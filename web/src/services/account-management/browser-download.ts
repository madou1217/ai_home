import type { ServerBlobResponse } from '../server-transport/contract.ts';
import { unsupportedAccountOperation } from './errors.ts';

// downloadBrowserBlob 只负责把已验证的 Go 单账号导出交给浏览器下载。
export async function downloadBrowserBlob(
  response: ServerBlobResponse,
  filename: string
): Promise<void> {
  if (
    typeof document === 'undefined'
    || typeof URL.createObjectURL !== 'function'
    || typeof URL.revokeObjectURL !== 'function'
  ) {
    unsupportedAccountOperation('account_management_download_unsupported');
  }
  const url = URL.createObjectURL(response.data);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
