import { useEffect } from 'react';

/**
 * The clipboard workspace is the standalone Paste Nexus page served from
 * /ui/paste/. Keep the Umi route as a thin bridge so existing navigation links
 * and bookmarks land on the same 1:1 HUD instead of the retired list page.
 */
export default function ClipboardPage() {
  useEffect(() => {
    window.location.replace('/ui/paste/');
  }, []);
  return null;
}
