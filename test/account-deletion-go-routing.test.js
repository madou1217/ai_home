'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  GO_DELETION_PROVIDERS,
  GO_DELETION_REQUIRED_PROVIDERS,
  resolveGoDeletionMode,
  handleDeleteAccountRequest
} = require('../lib/server/webui-account-routes');
const { PROVIDER_STORAGE_POLICIES } = require('../lib/runtime/provider-storage-policy');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const {
  ensureAccountRefsTable,
  resolveAccountRef
} = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

// 本轮新接入 Go 删除的 Provider。名单只用于断言覆盖范围，路由判定本身读
// GO_DELETION_PROVIDERS，不在测试里维护第二份分流名单。
const NEWLY_GO_ROUTED_PROVIDERS = Object.freeze([
  'codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn', 'kimi', 'kiro'
]);
// 走 Go 但允许回落本地删除的 Provider：运行态测试直接从 GO_DELETION_PROVIDERS
// 派生，Go 侧新增一家时自动纳入，不需要在测试里补名单。
const LOCAL_FALLBACK_PROVIDERS = Object.freeze(
  GO_DELETION_PROVIDERS.filter((provider) => !GO_DELETION_REQUIRED_PROVIDERS.includes(provider))
);

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const DELETION_SPEC_PATH = path.join(
  __dirname, '..', 'internal', 'adapters', 'accounts', 'deletionprojection', 'spec.go'
);
const DELETION_PREPARER_PATH = path.join(
  __dirname, '..', 'internal', 'adapters', 'accounts', 'deletionprojection', 'preparer.go'
);

const enabledGoHost = {
  isEnabled: () => true,
  deleteAccount: async () => ({ ok: true, status: 204 })
};
const disabledGoHost = {
  isEnabled: () => false,
  deleteAccount: async () => ({ ok: true, status: 204 })
};

// 从 Go 源码读取删除投影的 Provider 集合。Node 侧没有可读的删除合同
// （contracts/providers/manifest.json 生成自 core/providers，不含
// deletionprojection 的登记），所以守卫直接解析 projectionSpecs 的键：
// 键可能是 providerXxx 常量，也可能是字符串字面量，两种都解析。
function readGoProjectionProviders() {
  const specSource = fs.readFileSync(DELETION_SPEC_PATH, 'utf8');
  const preparerSource = fs.readFileSync(DELETION_PREPARER_PATH, 'utf8');
  const constants = new Map();
  for (const match of preparerSource.matchAll(/^\s*(provider[A-Za-z0-9_]+)\s*=\s*"([^"]+)"/gm)) {
    constants.set(match[1], match[2]);
  }

  const start = specSource.indexOf('var projectionSpecs = map[string]providerProjectionSpec{');
  assert.ok(start >= 0, 'spec.go 里找不到 projectionSpecs 注册表');
  const end = specSource.indexOf('\n}\n', start);
  assert.ok(end > start, 'spec.go 的 projectionSpecs 没有闭合');
  const block = specSource.slice(start, end);

  const providers = [];
  for (const match of block.matchAll(/^\t(?:([A-Za-z_][A-Za-z0-9_]*)|"([^"]+)")\s*:/gm)) {
    if (match[2]) {
      providers.push(match[2]);
      continue;
    }
    const value = constants.get(match[1]);
    assert.ok(value, `spec.go 引用了未知的 Provider 常量 ${match[1]}`);
    providers.push(value);
  }
  return [...new Set(providers)].sort();
}

function makeAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-delete-routing-'));
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

function createGoHost(mode) {
  const calls = [];
  return {
    calls,
    host: {
      isEnabled: () => mode !== 'disabled',
      deleteAccount: async (accountRef) => {
        calls.push(accountRef);
        if (mode === 'fail') {
          return { ok: false, status: 500, errorCode: 'go_delete_boom' };
        }
        return { ok: true, status: 204 };
      }
    }
  };
}

async function deleteViaRoute({ dir, provider, goHost, force = false, extraCtx = {} }) {
  const writes = [];
  const url = new URL(`http://127.0.0.1/v0/webui/accounts/${provider}/${ACCOUNT_REF}${force ? '?force=1' : ''}`);
  const ctx = {
    ...extraCtx,
    pathname: url.pathname,
    url,
    req: { url: url.pathname + url.search },
    res: {},
    fs,
    aiHomeDir: dir,
    deps: { aiHomeDir: dir, goCoreSync: goHost },
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
  const handled = await handleDeleteAccountRequest(ctx);
  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  return writes[0];
}

test('codex/claude 未启用 Go Core 时 fail-closed', () => {
  for (const provider of ['codex', 'claude']) {
    assert.equal(resolveGoDeletionMode(provider, null), 'required_unavailable');
    assert.equal(resolveGoDeletionMode(provider, disabledGoHost), 'required_unavailable');
  }
});

test('非 required 的已接入 Provider 未启用 Go Core 时回落本地删除', () => {
  const fallbackProviders = GO_DELETION_PROVIDERS
    .filter((provider) => !GO_DELETION_REQUIRED_PROVIDERS.includes(provider));
  for (const provider of fallbackProviders) {
    assert.equal(resolveGoDeletionMode(provider, null), 'local_fallback', provider);
    assert.equal(resolveGoDeletionMode(provider, disabledGoHost), 'local_fallback', provider);
  }
});

test('Go Core 启用时已接入的 Provider 都走 Go', () => {
  for (const provider of GO_DELETION_PROVIDERS) {
    assert.equal(resolveGoDeletionMode(provider, enabledGoHost), 'go', provider);
  }
});

test('codebuddy 家族、kimi 与 kiro 已进入 Go 删除名单', () => {
  for (const provider of NEWLY_GO_ROUTED_PROVIDERS) {
    assert.ok(GO_DELETION_PROVIDERS.includes(provider), `${provider} 不在 GO_DELETION_PROVIDERS`);
  }
});

test('未接入 Go 的 Provider 继续走本地删除', () => {
  for (const provider of ['agy', 'zcode']) {
    assert.equal(resolveGoDeletionMode(provider, enabledGoHost), 'local');
  }
});

test('Go 删除清单只包含存储策略表里存在的 Provider', () => {
  for (const provider of GO_DELETION_PROVIDERS) {
    assert.ok(PROVIDER_STORAGE_POLICIES[provider], `${provider} 不在 PROVIDER_STORAGE_POLICIES`);
  }
  for (const provider of GO_DELETION_REQUIRED_PROVIDERS) {
    assert.ok(GO_DELETION_PROVIDERS.includes(provider), `${provider} 必须在 Go 删除清单里`);
  }
});

test('Node 删除名单与 Go projectionSpecs 完全一致', () => {
  // 双向比对：Node 多一家会让它误以为 Go 能删，Go 多一家会让新 Provider
  // 静默退回本地删除。两个方向都必须失败。
  assert.deepEqual(
    [...GO_DELETION_PROVIDERS].sort(),
    readGoProjectionProviders()
  );
});

test('required_unavailable 在 release 之前拒绝：强杀占用者的事一步都不做', async (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir, 'codex');
  const { host, calls } = createGoHost('disabled');
  const aborted = [];
  const unregistered = [];
  const run = {
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    runId: 'run-1',
    sessionId: 'session-1',
    abort: () => aborted.push('run-1')
  };

  // force=1 表示用户已经确认「终止占用者并继续删除」；但 Go Core 不可用时删除
  // 根本无法落库，顺序必须是先 503、后 release（绝不能先杀再拒）。
  const result = await deleteViaRoute({
    dir,
    provider: 'codex',
    goHost: host,
    force: true,
    extraCtx: {
      listNativeChatRuns: () => [run],
      getNativeChatRun: (runId) => (runId === run.runId ? run : null),
      unregisterNativeChatRun: (runId) => unregistered.push(runId),
      listDesktopInstances: () => []
    }
  });

  assert.equal(result.status, 503);
  assert.equal(result.payload.error, 'go_core_required');
  assert.deepEqual(aborted, [], '不得在确认删除无法执行之前终止会话');
  assert.deepEqual(unregistered, [], '不得注销运行中的会话');
  assert.deepEqual(calls, []);
  assert.ok(
    resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
    '账号行不应被删除'
  );
});

test('可回落 Provider：Go 可用时调用 Go 并完成删除', async (t) => {
  for (const provider of LOCAL_FALLBACK_PROVIDERS) {
    const dir = makeAiHome(t);
    seedAccount(dir, provider);
    const { host, calls } = createGoHost('ok');

    const result = await deleteViaRoute({ dir, provider, goHost: host });

    assert.equal(result.status, 200, provider);
    assert.deepEqual(calls, [ACCOUNT_REF], provider);
    assert.equal(
      resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
      null,
      `${provider} 的账号行应已删除`
    );
  }
});

test('可回落 Provider：Go 不可用时回落本地删除', async (t) => {
  for (const provider of LOCAL_FALLBACK_PROVIDERS) {
    const dir = makeAiHome(t);
    seedAccount(dir, provider);
    const { host, calls } = createGoHost('disabled');

    const result = await deleteViaRoute({ dir, provider, goHost: host });

    assert.equal(result.status, 200, provider);
    assert.deepEqual(calls, [], `${provider} 不应调用 Go`);
    assert.equal(
      resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
      null,
      `${provider} 应由本地删除`
    );
  }
});

test('可回落 Provider：Go 删除失败返回 502 且不落本地删除', async (t) => {
  for (const provider of LOCAL_FALLBACK_PROVIDERS) {
    const dir = makeAiHome(t);
    seedAccount(dir, provider);
    const { host, calls } = createGoHost('fail');

    const result = await deleteViaRoute({ dir, provider, goHost: host });

    assert.equal(result.status, 502, provider);
    assert.equal(result.payload.error, 'go_delete_boom', provider);
    assert.deepEqual(calls, [ACCOUNT_REF], provider);
    assert.ok(
      resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
      `${provider} 的账号行不应被删除`
    );
  }
});
