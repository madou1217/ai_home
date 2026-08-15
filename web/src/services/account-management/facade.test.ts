import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountManagementClient } from './client.ts';
import { AccountManagementError } from './errors.ts';
import { AccountManagementFacade } from './facade.ts';
import type {
  ServerBlobResponse,
  ServerJsonResponse,
  ServerRequest
} from '../server-transport/contract.ts';

const ACCOUNT_ONE = 'acct_0123456789abcdef0123';
const ACCOUNT_TWO = 'acct_1123456789abcdef0123';
const JOB_ID = '0123456789abcdef0123456789abcdef';

type JsonHandler = (request: ServerRequest<unknown>) => {
  status: number;
  data: unknown;
};

class RouteTransport {
  readonly requests: Array<Pick<ServerRequest<unknown>, 'method' | 'path' | 'body'>> = [];
  private readonly handleJson: JsonHandler;
  private readonly blob: ServerBlobResponse;

  constructor(
    handleJson: JsonHandler,
    blob: ServerBlobResponse = {
      headers: {
        contentType: 'application/json',
        contentDisposition: 'attachment; filename="sub2api-data.json"'
      },
      data: new Blob(['{}'], { type: 'application/json' }),
      size: 2
    }
  ) {
    this.handleJson = handleJson;
    this.blob = blob;
  }

  async requestJson<TData, TBody>(
    request: ServerRequest<TBody>
  ): Promise<ServerJsonResponse<TData>> {
    this.requests.push({ method: request.method, path: request.path, body: request.body });
    return this.handleJson(request as ServerRequest<unknown>) as ServerJsonResponse<TData>;
  }

  async requestBlob<TBody>(request: ServerRequest<TBody>): Promise<ServerBlobResponse> {
    this.requests.push({ method: request.method, path: request.path, body: request.body });
    return this.blob;
  }
}

class FakeScheduler {
  private nextHandle = 1;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, number>();

  setTimeout(_callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle as unknown as ReturnType<typeof setTimeout>;
    this.nextHandle += 1;
    this.timers.set(handle, delayMs);
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers.delete(handle);
  }

  pendingDelays(): number[] {
    return [...this.timers.values()];
  }
}

test('Facade 用 keyset 列出 Codex/Claude，并行读取默认关系并跳过其他安全 Provider', async () => {
  const transport = new RouteTransport((request) => {
    if (request.path === '/v1/management/accounts?limit=255') {
      return {
        status: 200,
        data: accountPage([
          account(ACCOUNT_ONE, 'codex', 1),
          account('acct_0f23456789abcdef0123', 'gemini', 3)
        ], true, 'acct_0f23456789abcdef0123')
      };
    }
    if (request.path === '/v1/management/accounts?limit=255&after_ref=acct_0f23456789abcdef0123') {
      return {
        status: 200,
        data: accountPage([
          account(ACCOUNT_TWO, 'claude', 2),
          account('acct_3123456789abcdef0123', 'agy', 4)
        ], false, '')
      };
    }
    if (request.path === '/v1/management/account-defaults/codex') {
      return { status: 200, data: defaultEnvelope('codex', ACCOUNT_ONE) };
    }
    if (request.path === '/v1/management/account-defaults/claude') {
      return { status: 404, data: { error: { code: 'not_found' } } };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const facade = createFacade(transport);

  const snapshot = await facade.list();

  assert.deepEqual(snapshot.accounts.map(({ provider }) => provider), ['codex', 'claude']);
  assert.equal(snapshot.accounts[0]?.isDefault, true);
  assert.equal(snapshot.accounts[1]?.isDefault, false);
  assert.equal(snapshot.accounts[0]?.runtimeStatus, 'unknown');
  assert.equal(snapshot.hydrating, false);
  assert.deepEqual(transport.requests.slice(0, 3).map(({ path }) => path), [
    '/v1/management/accounts?limit=255',
    '/v1/management/account-defaults/codex',
    '/v1/management/account-defaults/claude'
  ]);
  assert.ok(transport.requests.every(({ path }) => path.startsWith('/v1/management/')));
  assert.ok(transport.requests.every(({ path }) => !path.includes('/usage')));
});

test('Facade 准确映射 OAuth 注册、回调和终态，不伪造 CLI 安装步骤', async () => {
  const transport = new RouteTransport((request) => {
    if (request.method === 'POST' && request.path === '/v1/management/account-auth-jobs') {
      return {
        status: 201,
        data: {
          data: {
            ...oauthJob('pending'),
            authorization_url: 'https://auth.example.test/authorize?state=opaque'
          }
        }
      };
    }
    if (
      request.method === 'GET'
      && request.path === `/v1/management/account-auth-jobs/${JOB_ID}`
    ) {
      return { status: 200, data: { data: oauthJob('pending') } };
    }
    if (request.method === 'POST' && request.path.endsWith('/callback')) {
      return {
        status: 200,
        data: {
          data: {
            ...oauthJob('completed'),
            finished_at: '2026-08-15T01:04:00Z',
            account_ref: ACCOUNT_ONE,
            cli_account_id: 1
          }
        }
      };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const facade = createFacade(transport);

  const started = await facade.add({ provider: 'codex', authMode: 'oauth-browser' });
  const polled = await facade.getAddJob(JOB_ID);
  const completed = await facade.completeBrowserCallback(
    JOB_ID,
    'http://localhost:1455/auth/callback?code=opaque&state=opaque'
  );

  assert.deepEqual(started, {
    ok: true,
    provider: 'codex',
    accountRef: '',
    authMode: 'oauth-browser',
    status: 'pending',
    jobId: JOB_ID,
    expiresAt: Date.parse('2026-08-15T01:12:00Z'),
    authorizationUrl: 'https://auth.example.test/authorize?state=opaque',
    authProgressState: 'awaiting_code',
    setupPhase: 'oauth',
    installRequired: false
  });
  assert.equal(
    polled.authorizationUrl,
    'https://auth.example.test/authorize?state=opaque'
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.accountRef, ACCOUNT_ONE);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.installRequired, false);
  assert.ok(transport.requests.every(({ path }) => !path.startsWith('/v0')));
});

test('静态账号变更显式通知 watcher，快照请求被合并且 close 清理轮询', async () => {
  let listReads = 0;
  const scheduler = new FakeScheduler();
  const transport = new RouteTransport((request) => {
    if (request.path.startsWith('/v1/management/accounts?')) {
      listReads += 1;
      return { status: 200, data: accountPage([], false, '') };
    }
    if (request.path.startsWith('/v1/management/account-defaults/')) {
      return { status: 404, data: null };
    }
    if (request.method === 'POST' && request.path === '/v1/management/accounts') {
      return { status: 201, data: { data: account(ACCOUNT_ONE, 'codex', 1, 'api_key') } };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const facade = new AccountManagementFacade({
    clientFactory: async () => new AccountManagementClient({
      transport,
      profileId: 'profile-test'
    }),
    visibility: null,
    pollIntervalMs: 30_000,
    scheduler
  });
  const snapshots: number[] = [];
  const changed: string[] = [];
  const watcher = facade.watch({
    onSnapshot: ({ accounts }) => snapshots.push(accounts.length),
    onAccount: ({ accountRef }) => changed.push(accountRef)
  });
  await flushMicrotasks();
  assert.deepEqual(scheduler.pendingDelays(), [30_000]);

  await facade.add({
    provider: 'codex',
    authMode: 'api-key',
    config: { apiKey: 'synthetic-static-key' }
  });
  await flushMicrotasks();
  watcher.close();

  assert.deepEqual(changed, [ACCOUNT_ONE]);
  assert.ok(snapshots.length >= 2);
  assert.ok(listReads >= 2);
  assert.deepEqual(scheduler.pendingDelays(), []);
  const createRequest = transport.requests.find(({ method, path }) => (
    method === 'POST' && path === '/v1/management/accounts'
  ));
  assert.deepEqual(createRequest?.body, {
    provider_id: 'codex',
    auth: { kind: 'api_key', api_key: 'synthetic-static-key' }
  });
});

test('导入只接收单份文本 sub2api，立即返回结果且单账号导出直接下载', async () => {
  const downloads: string[] = [];
  const transport = new RouteTransport((request) => {
    if (request.path === '/v1/management/account-imports/sub2api') {
      return { status: 200, data: { data: account(ACCOUNT_TWO, 'claude', 2, 'auth_token') } };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const facade = new AccountManagementFacade({
    clientFactory: async () => new AccountManagementClient({
      transport,
      profileId: 'profile-test'
    }),
    visibility: null,
    downloadBlob: async (_response, filename) => {
      downloads.push(filename);
    }
  });
  const document = JSON.stringify({
    type: 'sub2api-data',
    version: 1,
    exported_at: '2026-08-15T01:00:00Z',
    proxies: [],
    accounts: [{
      name: 'claude-account',
      platform: 'anthropic',
      type: 'setup-token',
      credentials: { setup_token: 'opaque' },
      concurrency: 0,
      priority: 0
    }]
  });

  const result = await facade.import({
    mode: 'upload',
    uploadKind: 'file',
    files: [{ name: 'sub2api.json', content: document, encoding: 'text' }]
  });
  await facade.exportAccount(ACCOUNT_TWO);

  assert.equal(result.imported, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.jobId, undefined);
  assert.equal(result.summary?.created, 0);
  assert.equal(result.summary?.updated, 1);
  assert.equal(result.summary?.accounts[0]?.status, 'updated');
  assert.equal(result.summary?.accounts[0]?.accountRef, ACCOUNT_TWO);
  assert.deepEqual(downloads, [`sub2api-${ACCOUNT_TWO}.json`]);
  assert.deepEqual(transport.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v1/management/account-imports/sub2api' },
    { method: 'GET', path: `/v1/management/accounts/${ACCOUNT_TWO}/export` }
  ]);
});

test('Facade 只按显式账号读取和刷新 Go 模型快照，不伪造后台 Job', async () => {
  const transport = new RouteTransport((request) => {
    if (
      request.path === `/v1/management/accounts/${ACCOUNT_ONE}/models`
      || request.path === `/v1/management/accounts/${ACCOUNT_ONE}/models/refresh`
    ) {
      return {
        status: 200,
        data: {
          data: [{
            model_id: 'gpt-5.6-sol',
            upstream_available: true,
            manual_policy: request.method === 'PATCH' ? 'force_disable' : 'inherit',
            effective: request.method !== 'PATCH',
            updated_at: '2026-08-15T01:04:00Z'
          }]
        }
      };
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  });
  const facade = createFacade(transport);

  const listed = await facade.listAccountModels(ACCOUNT_ONE);
  const refreshed = await facade.refreshAccountModels(ACCOUNT_ONE);
  const policyUpdated = await facade.setAccountModelPolicy(
    ACCOUNT_ONE,
    'gpt-5.6-sol',
    'force_disable'
  );

  assert.deepEqual(listed, refreshed);
  assert.equal(listed[0]?.modelId, 'gpt-5.6-sol');
  assert.equal(policyUpdated[0]?.manualPolicy, 'force_disable');
  assert.deepEqual(transport.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: `/v1/management/accounts/${ACCOUNT_ONE}/models` },
    { method: 'POST', path: `/v1/management/accounts/${ACCOUNT_ONE}/models/refresh` },
    { method: 'PATCH', path: `/v1/management/accounts/${ACCOUNT_ONE}/models` }
  ]);
  assert.deepEqual(transport.requests[2]?.body, {
    model_id: 'gpt-5.6-sol',
    manual_policy: 'force_disable'
  });
});

test('未支持能力 fail closed，且传输异常不会把静态密钥带入旧页面错误结构', async () => {
  let clientCreations = 0;
  const facade = new AccountManagementFacade({
    clientFactory: async () => {
      clientCreations += 1;
      throw new Error('unexpected_client_creation');
    },
    visibility: null
  });

  await assert.rejects(
    facade.add({ provider: 'codex', authMode: 'oauth-device' }),
    /account_management_oauth_device_unsupported/
  );
  await assert.rejects(facade.setMobile('codex', ACCOUNT_ONE), /mobile_role_unsupported/);
  await assert.rejects(facade.export('sub2api'), /global_export_unsupported/);
  await assert.rejects(
    facade.import({ mode: 'upload', uploadKind: 'folder', files: [] }),
    /bulk_import_unsupported/
  );
  await assert.rejects(
    facade.import({ mode: 'cliproxyapi' }),
    /cliproxy_import_unsupported/
  );
  await assert.rejects(facade.confirmCliInstall(JOB_ID), /cli_install_unsupported/);
  assert.equal(clientCreations, 0);

  const secret = 'synthetic-secret-must-not-leak';
  const failingTransport = new RouteTransport(() => {
    throw new Error(`upstream rejected ${secret}`);
  });
  const failingFacade = createFacade(failingTransport);
  const error = await failingFacade.add({
    provider: 'codex',
    authMode: 'api-key',
    config: { apiKey: secret }
  }).then(
    () => null,
    (caught: unknown) => caught
  );

  assert.ok(error instanceof AccountManagementError);
  assert.doesNotMatch(String(error), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  assert.doesNotMatch(error.response.data.message, new RegExp(secret));
});

test('Facade 合并同一账号的并发删除，只发送一次破坏性请求', async () => {
  const transport = new RouteTransport((request) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.path, `/v1/management/accounts/${ACCOUNT_ONE}`);
    return { status: 204, data: null };
  });
  const facade = createFacade(transport);

  await Promise.all([
    facade.delete('codex', ACCOUNT_ONE),
    facade.delete('codex', ACCOUNT_ONE)
  ]);

  assert.equal(transport.requests.length, 1);
});

function createFacade(transport: RouteTransport): AccountManagementFacade {
  return new AccountManagementFacade({
    clientFactory: async () => new AccountManagementClient({
      transport,
      profileId: 'profile-test'
    }),
    visibility: null
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function accountPage(
  data: Record<string, unknown>[],
  hasMore: boolean,
  nextAfterRef: string
) {
  return {
    data,
    page: { limit: 255, has_more: hasMore, next_after_ref: nextAfterRef }
  };
}

function account(
  accountRef: string,
  providerId: string,
  cliAccountId: number,
  authKind = 'oauth'
): Record<string, unknown> {
  return {
    account_ref: accountRef,
    provider_id: providerId,
    cli_account_id: cliAccountId,
    enabled: true,
    has_credential: true,
    auth_kind: authKind,
    auth_mode: authKind === 'oauth' ? 'refreshable' : '',
    has_profile: true,
    display_name: `Account ${cliAccountId}`,
    email: `account-${cliAccountId}@example.test`,
    subscription_kind: providerId === 'codex' ? 'plus' : 'max',
    subscription_raw: providerId === 'codex' ? 'plus' : 'max',
    profile_updated_at: '2026-08-15T01:00:00Z',
    model_summary: null,
    usage_snapshot: null,
    created_at: '2026-08-15T01:00:00Z',
    updated_at: '2026-08-15T01:01:00Z'
  };
}

function defaultEnvelope(providerId: string, accountRef: string) {
  return {
    data: {
      provider_id: providerId,
      account_ref: accountRef,
      updated_at: '2026-08-15T01:02:00Z'
    }
  };
}

function oauthJob(status: string): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    provider_id: 'codex',
    purpose: 'register',
    status,
    created_at: '2026-08-15T01:02:00Z',
    expires_at: '2026-08-15T01:12:00Z'
  };
}
