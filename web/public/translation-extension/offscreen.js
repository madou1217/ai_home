/* global chrome, navigator */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'aih-offscreen-clipboard-write') return false;
  const text = String(message.text || '');
  navigator.clipboard.writeText(text)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
