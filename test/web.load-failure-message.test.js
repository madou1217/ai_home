const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadFailureMessages() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'load-failure-message.js'
  )).href;
  return import(modulePath);
}

function createMessageApi() {
  const visible = new Map();
  return {
    visible,
    error({ key, content }) {
      visible.set(key, content);
    },
    destroy(key) {
      visible.delete(key);
    }
  };
}

test('a successful live snapshot clears an earlier keyed load failure', async () => {
  const {
    ACCOUNT_LIST_LOAD_MESSAGE_KEY,
    clearLoadFailureMessage,
    showLoadFailureMessage
  } = await loadFailureMessages();
  const messageApi = createMessageApi();

  showLoadFailureMessage(messageApi, ACCOUNT_LIST_LOAD_MESSAGE_KEY, '加载账号失败');
  assert.equal(messageApi.visible.get(ACCOUNT_LIST_LOAD_MESSAGE_KEY), '加载账号失败');

  clearLoadFailureMessage(messageApi, ACCOUNT_LIST_LOAD_MESSAGE_KEY);
  assert.equal(messageApi.visible.has(ACCOUNT_LIST_LOAD_MESSAGE_KEY), false);
});

test('clearing one load failure does not hide failures for another resource', async () => {
  const {
    CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY,
    CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY,
    CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
    CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY,
    clearLoadFailureMessage,
    showLoadFailureMessage
  } = await loadFailureMessages();
  const messageApi = createMessageApi();

  assert.equal(CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY, 'chat-session-history-load-failed');

  showLoadFailureMessage(messageApi, CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY, '加载账号失败');
  showLoadFailureMessage(messageApi, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY, '加载项目失败');
  showLoadFailureMessage(messageApi, CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY, '加载项目会话失败');
  showLoadFailureMessage(messageApi, CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY, '加载会话历史失败');
  clearLoadFailureMessage(messageApi, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY);

  assert.equal(messageApi.visible.get(CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY), '加载账号失败');
  assert.equal(messageApi.visible.get(CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY), '加载项目会话失败');
  assert.equal(messageApi.visible.get(CHAT_SESSION_HISTORY_LOAD_MESSAGE_KEY), '加载会话历史失败');
  assert.equal(messageApi.visible.has(CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY), false);
});
