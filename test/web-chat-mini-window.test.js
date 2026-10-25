'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mini = fs.readFileSync(path.join(root, 'web/src/features/chat-runtime/ChatMiniWindow.tsx'), 'utf8');
const shortcuts = fs.readFileSync(path.join(root, 'web/src/components/chat/chat-global-shortcuts.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web/src/app.tsx'), 'utf8');

 test('Web Chat mini-window uses the canonical runtime and is mounted at the app shell', () => {
  assert.match(mini, /useSessionRuntime/);
  assert.match(mini, /SessionRuntimeActions/);
  assert.match(mini, /SessionWorkspace/);
  assert.match(mini, /runtimeAccountsForSession/);
  assert.match(mini, /CHAT_MINI_WINDOW_OPEN_EVENT/);
  assert.match(app, /<ChatMiniWindow \/>/);
  assert.doesNotMatch(mini, /new EventSource|fetch\s*\(/);
});

test('Chat mini-window shortcut is route-independent and keeps failures inline', () => {
  assert.match(shortcuts, /chat-mini-window/);
  assert.match(shortcuts, /altKey/);
  assert.match(shortcuts, /CHAT_MINI_WINDOW_OPEN_EVENT/);
  assert.match(mini, /role="alert"/);
  assert.doesNotMatch(mini, /<Alert\b/);
});
