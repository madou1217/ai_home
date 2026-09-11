'use strict';
// 探针：向存活的 chat harness app-server 直接发 thread/inject_items，
// 验证 1M 字符上限是否作用于历史注入通道（turn/start 已被确认有 1,048,576 字符上限）。
const { createAppServerClient } = require('../lib/server/codex-app-server-json-rpc-client');

const THREAD_ID = '01a09057-d229-7e23-a7cf-9c28f1b845e3';
const BIG = '数据'.repeat(760000); // ≈152 万字符，超过 1,048,576

async function main() {
  const client = createAppServerClient({
    resolveEndpoint: async () => 'ws://127.0.0.1:50750',
    accountIdentityValidator: async () => ({
      verified: true,
      kind: 'api-key',
      assurance: 'execution-credential',
      executionAccountHash: 'a'.repeat(64),
      runtimeHomeHash: 'b'.repeat(64)
    })
  });
  try {
    // 先确认线程存在
    const resume = await client.request('thread/resume', { threadId: THREAD_ID }).then(
      () => 'thread-ok',
      (error) => `thread-error: ${error.code || ''} ${String(error.message || error).slice(0, 200)}`
    );
    console.log('resume:', resume);

    const bigItem = {
      type: 'message',
      id: `probe-${Date.now()}`,
      role: 'user',
      content: [{ type: 'input_text', text: BIG }]
    };
    const single = await client.request('thread/inject_items', { threadId: THREAD_ID, items: [bigItem] }).then(
      () => 'ACCEPTED',
      (error) => `REJECTED: ${String(error.message || error).slice(0, 200)}`
    );
    console.log('inject_items single 1.5M-char item:', single);

    const chunks = [0, 1, 2].map((index) => ({
      type: 'message',
      id: `probe-chunk-${Date.now()}-${index}`,
      role: 'user',
      content: [{ type: 'input_text', text: '块'.repeat(500000) }]
    }));
    const chunked = await client.request('thread/inject_items', { threadId: THREAD_ID, items: chunks }).then(
      () => 'ACCEPTED',
      (error) => `REJECTED: ${String(error.message || error).slice(0, 200)}`
    );
    console.log('inject_items 3x500K chars (total 1.5M):', chunked);
  } finally {
    if (client.destroy) client.destroy();
  }
}

main().catch((error) => { console.error('PROBE FAILED', error); process.exit(1); });

// 追加：thread/read 检查注入条目的可见性
async function readback() {
  const client = createAppServerClient({
    resolveEndpoint: async () => 'ws://127.0.0.1:50750',
    accountIdentityValidator: async () => ({
      verified: true, kind: 'api-key', assurance: 'execution-credential',
      executionAccountHash: 'a'.repeat(64), runtimeHomeHash: 'b'.repeat(64)
    })
  });
  try {
    const res = await client.request('thread/read', { threadId: THREAD_ID, includeTurns: true }).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
    if (res.error) { console.log('thread/read:', res.error); return; }
    const turns = res.thread && res.thread.turns || [];
    console.log('turns:', turns.length);
    let found = 0;
    for (const turn of turns) {
      for (const item of turn.items || []) {
        if (String(item.id || '').startsWith('probe')) found += 1;
      }
    }
    console.log('probe items visible inside turns:', found);
    console.log('thread keys:', Object.keys(res.thread || {}).join(','));
  } finally { if (client.destroy) client.destroy(); }
}
readback().catch((e) => { console.error('READBACK FAILED', e); process.exit(1); });
