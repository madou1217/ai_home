'use strict';

// 驱动层回归守卫：v4 会话帧里的 assistantText 必须实时转成 onText 增量，
// 而不是等 turn 结束从会话库整段回放。用假子进程模拟 app-server 的 RPC/通知，
// 不依赖真实 CLI/网络。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runZcodeAppServerPrompt } = require('../lib/cli/services/ai-cli/zcode-app-server-run');

function createFakeChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    write(line) {
      let message = null;
      try { message = JSON.parse(line); } catch (_error) { return; }
      onWrite(message, child);
    }
  };
  return child;
}

function pushLine(child, message) {
  child.stdout.emit('data', `${JSON.stringify(message)}\n`);
}

function respond(child, message, result) {
  pushLine(child, { id: message.id, result });
}

test('assistantText 的 row.delta 实时走 onText，最终不重复整段回放', async () => {
  const chunks = [];
  const child = createFakeChild((message, target) => {
    const method = String(message.method || '');
    if (method === 'v4/command') {
      const type = message.params && message.params.type;
      respond(target, message, { status: 'accepted' });
      if (type === 'sendText') {
        setTimeout(() => {
          pushLine(target, {
            method: 'v4/conversation/frame',
            params: {
              frame: {
                payload: {
                  kind: 'deltas',
                  deltas: [{
                    op: 'row.appended',
                    row: { rowId: 7, kind: 'assistantText', text: '', state: 'streaming' }
                  }]
                }
              }
            }
          });
          pushLine(target, {
            method: 'v4/conversation/frame',
            params: {
              frame: {
                payload: {
                  kind: 'deltas',
                  deltas: [
                    { op: 'row.delta', rowId: 7, path: 'text', append: '你' },
                    { op: 'row.delta', rowId: 7, path: 'text', append: '好' }
                  ]
                }
              }
            }
          });
          pushLine(target, {
            method: 'v4/conversation/frame',
            params: {
              frame: {
                payload: {
                  kind: 'deltas',
                  deltas: [{
                    op: 'row.upserted',
                    row: { rowId: 7, kind: 'assistantText', text: '你好', state: 'complete' }
                  }]
                }
              }
            }
          });
          pushLine(target, {
            method: 'v4/telemetry/event',
            params: { kind: 'turn.terminal', status: 'success' }
          });
        }, 5);
      }
      return;
    }
    // 其余 RPC（provider/updateAccountConfig、subscribe、resume、setMode…）
    respond(target, message, {});
  });

  const result = await runZcodeAppServerPrompt({
    cliPath: '/fake/zcode.cjs',
    prompt: '你好',
    providerId: 'account:bigmodel-start-plan',
    modelId: 'GLM-5.3-Flash',
    planMode: 'start-plan',
    // 注入登录态，避免测试碰真实账号库/网络。
    oauth: { activeProvider: 'bigmodel', accessToken: 'tok', jwtToken: 'jwt' },
    plainCredentials: {},
    cliDbPath: '/tmp/aih-zcode-fake-missing.sqlite',
    timeoutMs: 2500,
    onText: (text) => chunks.push(text),
    deps: { spawnImpl: () => child }
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, '你好');
  assert.deepEqual(chunks, ['你', '好']);
  assert.equal(child.killed, true, 'turn 完成后应关闭子进程');
});
