const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadQueuePresentation() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'queue-presentation.js'
  )).href;
  return import(modulePath);
}

test('queue presentation maps mode and position into stable labels and explanations', async () => {
  const {
    getQueueModeLabel,
    getQueueModeDescription,
    getQueuePrimaryActionLabel,
    getQueuePrimaryActionTitle
  } = await loadQueuePresentation();

  assert.equal(getQueueModeLabel('after_tool_call', 0), '工具后');
  assert.equal(getQueueModeLabel('after_tool_call', 2), '工具后 3');
  assert.equal(getQueueModeLabel('after_turn', 0), '下一条');
  assert.equal(getQueueModeLabel('after_turn', 1), '排队 2');
  assert.match(getQueueModeDescription('after_tool_call'), /工具调用边界后尽快注入/);
  assert.match(getQueueModeDescription('after_turn'), /当前这一轮完成后自动发送/);
  assert.equal(getQueuePrimaryActionLabel(false, 0), '立即发送');
  assert.equal(getQueuePrimaryActionLabel(true, 0), '立即介入');
  assert.equal(getQueuePrimaryActionLabel(true, 2), '提到最前');
  assert.match(getQueuePrimaryActionTitle(true, 2), /提到队首并停止当前轮/);
});
