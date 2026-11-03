/** Write text to the clipboard in browsers with and without Clipboard API permission. */
export async function writeClipboardText(value: string): Promise<void> {
  const text = String(value ?? '');
  if (!text) throw new Error('没有可复制的内容');
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (_error) {
      // Fall through to the synchronous selection fallback. This covers HTTP
      // deployments, remote desktops and browsers with denied clipboard permission.
    }
  }
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('当前环境不支持剪贴板写入');
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了剪贴板写入');
  } finally {
    textarea.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}
