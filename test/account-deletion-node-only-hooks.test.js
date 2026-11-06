'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NODE_ONLY_DELETION_HOOKS } = require('../lib/server/node-only-deletion-hooks');
const { handleDeleteAccountRequest } = require('../lib/server/webui-account-routes');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const {
  ensureAccountRefsTable,
  resolveAccountRef
} = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const {
  readAccountEgressBinding,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');

const REPO_ROOT = path.join(__dirname, '..');
const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function makeAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-delete-node-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedAccount(dir, provider) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  try {
    ensureAccountRefsTable(db);
    db.prepare(`
      INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(ACCOUNT_REF, provider, 1, 1);
  } finally {
    db.close();
  }
  writeAccountCredentials(fs, dir, ACCOUNT_REF, {});
}

async function deleteViaRoute({ dir, provider, extraCtx = {} }) {
  const writes = [];
  const url = new URL(`http://127.0.0.1/v0/webui/accounts/${provider}/${ACCOUNT_REF}`);
  const ctx = {
    ...extraCtx,
    pathname: url.pathname,
    url,
    req: { url: url.pathname },
    res: {},
    fs,
    aiHomeDir: dir,
    deps: { aiHomeDir: dir },
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
  const handled = await handleDeleteAccountRequest(ctx);
  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  return writes[0];
}

// 登记表不是文档：每个 hook 必须能被 require 出同名函数，且调用点源码里真的
// 调用了它。Go 侧守卫读同一份表，两边键集合必须一致。
test('node-only 删除钩子表指向真实导出与调用点', () => {
  assert.deepEqual(Object.keys(NODE_ONLY_DELETION_HOOKS).sort(), ['agy', 'zcode']);
  for (const [provider, hooks] of Object.entries(NODE_ONLY_DELETION_HOOKS)) {
    // Go 守卫按「  provider: Object.freeze(」解析键；写成引号键会让它静默漏掉。
    assert.match(provider, /^[a-z0-9_]+$/, `登记表键必须是裸 Provider ID: ${provider}`);
    assert.ok(Array.isArray(hooks) && hooks.length > 0, `${provider} 没有登记 hook`);
    for (const hook of hooks) {
      const exported = require(path.join(REPO_ROOT, hook.file));
      assert.equal(
        typeof exported[hook.export],
        'function',
        `${provider} 的 ${hook.file}#${hook.export} 不是可调用导出`
      );
      assert.ok(hook.callSites.length > 0, `${provider} 的 ${hook.export} 没有调用点`);
      for (const callSite of hook.callSites) {
        const source = fs.readFileSync(path.join(REPO_ROOT, callSite), 'utf8');
        assert.match(
          source,
          new RegExp(`\\b${hook.export}\\s*\\(`),
          `${provider} 的调用点 ${callSite} 没有调用 ${hook.export}`
        );
      }
    }
  }
});

// 暖机 LS 池是 Node 进程内状态：删除必须经过它的驱逐 hook，驱逐不掉必须
// fail-closed（409），不能落库后再留下一个攥着已删凭据的进程。
test('agy 删除会先驱逐暖机 LS，驱逐失败则拒绝删除', async (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir, 'agy');
  const evicted = [];
  const deleted = await deleteViaRoute({
    dir,
    provider: 'agy',
    extraCtx: {
      listDesktopInstances: () => [],
      agyWarmPool: {
        evict: async (accountRef) => {
          evicted.push(accountRef);
          return true;
        }
      }
    }
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(evicted, [ACCOUNT_REF]);

  const blockedDir = makeAiHome(t);
  seedAccount(blockedDir, 'agy');
  const blocked = await deleteViaRoute({
    dir: blockedDir,
    provider: 'agy',
    extraCtx: {
      listDesktopInstances: () => [],
      agyWarmPool: { evict: async () => false }
    }
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.payload.message, /agy_warm_writer/);
  assert.ok(
    resolveAccountRef(fs, blockedDir, ACCOUNT_REF, { bestEffort: true }),
    '驱逐失败时账号行必须保留'
  );
});

// zcode 的出口绑定在 Node 独占的 app-state.db（app_kv）：Go 的 aih.db 删除
// 不会带走它，所以删除路径必须自己清理，否则会留下指向已删账号的孤儿绑定。
test('zcode 删除会清掉 Node 独占的出口绑定', async (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir, 'zcode');
  writeAccountEgressBinding(fs, dir, ACCOUNT_REF, { mode: 'direct' });
  assert.ok(readAccountEgressBinding(fs, dir, ACCOUNT_REF), '测试前应存在出口绑定');

  const result = await deleteViaRoute({
    dir,
    provider: 'zcode',
    extraCtx: {
      listDesktopInstances: () => [],
      agyWarmPool: {
        evict: async () => {
          throw new Error('zcode 删除不应触碰 agy 暖机池');
        }
      }
    }
  });

  assert.equal(result.status, 200);
  assert.equal(readAccountEgressBinding(fs, dir, ACCOUNT_REF), null);
});
