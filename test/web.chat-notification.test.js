const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadChatNotification() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'pages',
    'chat-notification.js'
  )).href;
  return import(modulePath);
}

test('shouldNotifyAssistantCompleted only fires when permission granted and page is not actively focused', async () => {
  const { shouldNotifyAssistantCompleted } = await loadChatNotification();

  assert.equal(shouldNotifyAssistantCompleted({
    permission: 'default',
    visibilityState: 'hidden',
    hasFocus: false
  }), false);

  assert.equal(shouldNotifyAssistantCompleted({
    permission: 'granted',
    visibilityState: 'visible',
    hasFocus: true
  }), false);

  assert.equal(shouldNotifyAssistantCompleted({
    permission: 'granted',
    visibilityState: 'hidden',
    hasFocus: false
  }), true);
});

test('buildAssistantCompletionNotification trims content and falls back to default body', async () => {
  const { buildAssistantCompletionNotification } = await loadChatNotification();

  const payload = buildAssistantCompletionNotification('codex', '  已完成一轮很长的回复  ', { codex: 'Codex' });
  assert.equal(payload.title, 'Codex 已完成');
  assert.equal(payload.body, '已完成一轮很长的回复');

  const fallback = buildAssistantCompletionNotification('claude', '   ', { claude: 'Claude' });
  assert.equal(fallback.title, 'Claude 已完成');
  assert.equal(fallback.body, '回复已完成，点击返回查看');
});
