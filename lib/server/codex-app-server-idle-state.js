'use strict';

const { createAppServerClient } = require('./codex-app-server-json-rpc-client');

// 旧 pane 的启动策略只能在原生线程全空闲时更新；探测不明就保留运行态。
async function isCodexAppServerIdle(port, options = {}) {
  const client = (options.clientFactory || createAppServerClient)({
    resolveEndpoint: async () => `ws://127.0.0.1:${port}`
  });
  let timer;
  try {
    const inspect = async () => {
      let cursor;
      const seen = new Set();
      do {
        const loaded = await client.request('thread/loaded/list', cursor ? { cursor } : {});
        if (!Array.isArray(loaded && loaded.data)) return false;
        for (const threadId of loaded.data) {
          const result = await client.request('thread/read', { threadId, includeTurns: false });
          if (!['idle', 'notLoaded'].includes(result && result.thread && result.thread.status && result.thread.status.type)) return false;
        }
        cursor = loaded.nextCursor;
        if (cursor && seen.has(cursor)) return false;
        if (cursor) seen.add(cursor);
      } while (cursor);
      return true;
    };
    return await Promise.race([
      inspect().catch(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), options.timeoutMs || 5000); })
    ]);
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
}

module.exports = { isCodexAppServerIdle };
