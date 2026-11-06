'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 回归守卫（2026-11-06）：连接阶段允许先输入。
// 旧实现 dispatch 在非 connected 时直接 reject，composer 只能看不能发；
// 现在 connecting 等首屏快照（startTask）完成即可下发，重连/重同步仍等 connected。
test('connecting keeps the composer interactive and dispatches after the snapshot', () => {
  const presentation = fs.readFileSync(
    path.join(__dirname, '../web/src/features/chat-runtime/session-connection-presentation.ts'),
    'utf8',
  );
  const connectingStart = presentation.indexOf('connecting: {');
  const connectingBlock = presentation.slice(connectingStart, presentation.indexOf('\n  },\n', connectingStart));
  assert.match(connectingBlock, /interactive: true/);
  assert.doesNotMatch(connectingBlock, /notice:/);

  const controller = fs.readFileSync(
    path.join(__dirname, '../web/src/chat-runtime/session-runtime-controller.ts'),
    'utf8',
  );
  const dispatchBody = controller.slice(controller.indexOf('async dispatch<'), controller.indexOf('readTimeline('));
  assert.doesNotMatch(dispatchBody, /getConnectionState\(\) !== 'connected'/);
  assert.match(dispatchBody, /await this\.waitUntilDispatchReady\(\)/);

  const readyBody = controller.slice(
    controller.indexOf('private async waitUntilDispatchReady'),
    controller.indexOf('private waitForConnected'),
  );
  assert.match(readyBody, /state === 'connecting'/);
  assert.match(readyBody, /await this\.startTask/);
});
