'use strict';

const { createAnsiTerminalScreen } = require('./ansi-terminal-screen');

const RETRY_PATTERN = /Retrying\s*in\s*(\d+(?:\.\d+)?)s\s*[·•]\s*attempt\s*(\d+)\s*\/\s*(\d+)/gi;

function findHttpStatus(text) {
  const matches = String(text || '').match(/\b[45]\d{2}\b/g);
  return matches && matches.length > 0 ? Number(matches[matches.length - 1]) : undefined;
}

function createClaudeRetryObserver(options = {}) {
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : () => {};
  const screen = createAnsiTerminalScreen();
  let activeAttemptSignature = '';

  function observe(output) {
    screen.feed(output);
    const text = screen.toText();
    RETRY_PATTERN.lastIndex = 0;
    let match;
    let latestMatch = null;
    while ((match = RETRY_PATTERN.exec(text)) !== null) latestMatch = match;
    if (!latestMatch) {
      activeAttemptSignature = '';
      return;
    }
    const retryAfterMs = Math.round(Number(latestMatch[1]) * 1000);
    const attempt = Number(latestMatch[2]);
    const maxAttempts = Number(latestMatch[3]);
    const signature = `${attempt}/${maxAttempts}`;
    if (signature === activeAttemptSignature) return;
    activeAttemptSignature = signature;
    const context = text.slice(Math.max(0, latestMatch.index - 500), latestMatch.index);
    onRetry({
      attempt,
      maxAttempts,
      retryAfterMs,
      status: findHttpStatus(context)
    });
  }

  return { observe };
}

module.exports = {
  createClaudeRetryObserver,
  findHttpStatus
};
