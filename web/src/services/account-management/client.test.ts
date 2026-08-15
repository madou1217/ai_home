import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountManagementClient } from './client.ts';
import {
  AccountManagementError,
  formatAccountManagementError
} from './errors.ts';
import { projectAccountView } from './projection.ts';
import type {
  ServerBlobResponse,
  ServerJsonResponse,
  ServerRequest
} from '../server-transport/contract.ts';

const ACCOUNT_ONE = 'acct_0123456789abcdef0123';
const ACCOUNT_TWO = 'acct_1123456789abcdef0123';
const JOB_ID = '0123456789abcdef0123456789abcdef';

interface QueuedJsonResponse {
  status: number;
  data: unknown;
}

// FakeTransport 记录完整合同请求，但不格式化或记录请求体。
class FakeTransport {
  readonly requests: Array<ServerRequest<unknown> & { port: 'json' | 'blob' }> = [];
  private readonly responses: QueuedJsonResponse[];
  private readonly blobResponse: ServerBlobResponse;

  constructor(
    responses: QueuedJsonResponse[],
    blobResponse: ServerBlobResponse = {
      headers: {
        contentType: 'application/json; charset=utf-8',
        contentDisposition: 'attachment; filename="sub2api-data.json"'
      },
      data: new Blob(['{}'], { type: 'application/json' }),
      size: 2
    }
  ) {
    this.responses = [...responses];
    this.blobResponse = blobResponse;
  }

  async requestJson<TData, TBody>(
    request: ServerRequest<TBody>
  ): Promise<ServerJsonResponse<TData>> {
    this.requests.push({ ...request, port: 'json' } as ServerRequest<unknown> & { port: 'json' });
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected_request');
    return response as ServerJsonResponse<TData>;
  }

  async requestBlob<TBody>(request: ServerRequest<TBody>): Promise<ServerBlobResponse> {
    this.requests.push({ ...request, port: 'blob' } as ServerRequest<unknown> & { port: 'blob' });
    return this.blobResponse;
  }
}

test('账号客户端完整遍历 keyset 且列表不触发 usage N+1', async () => {
  const transport = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'codex', 1)], true, ACCOUNT_ONE)),
    json(200, accountPage([account(ACCOUNT_TWO, 'claude', 2)], false, ''))
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-aws' });

  const accounts = await client.listAllAccounts();

  assert.deepEqual(accounts.map(({ accountRef }) => accountRef), [ACCOUNT_ONE, ACCOUNT_TWO]);
  assert.deepEqual(transport.requests.map(({ path }) => path), [
    '/v1/management/accounts?limit=255',
    `/v1/management/accounts?limit=255&after_ref=${ACCOUNT_ONE}`
  ]);
  assert.ok(transport.requests.every(({ profileId }) => profileId === 'profile-aws'));
  assert.ok(transport.requests.every(({ path }) => !path.includes('/usage')));
});

test('静态创建、启停、轮换、默认关系和删除使用规范路径与互斥凭据 DTO', async () => {
  const transport = new FakeTransport([
    json(201, envelope(account(ACCOUNT_ONE, 'claude', 1, 'auth_token'))),
    json(200, envelope({ ...account(ACCOUNT_ONE, 'claude', 1, 'auth_token'), enabled: false })),
    json(200, envelope(account(ACCOUNT_ONE, 'claude', 1, 'api_key'))),
    json(200, defaultEnvelope('claude', ACCOUNT_ONE)),
    json(200, defaultEnvelope('claude', ACCOUNT_ONE)),
    json(204, null),
    json(204, null)
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  await client.createStaticAccount('claude', {
    kind: 'auth_token', authToken: 'claude-static-token', baseUrl: 'https://api.example.test'
  });
  await client.setAccountEnabled(ACCOUNT_ONE, false);
  await client.rotateCredential(ACCOUNT_ONE, 'claude', {
    kind: 'api_key', apiKey: 'claude-api-key'
  });
  await client.getProviderDefault('claude');
  await client.setProviderDefault('claude', ACCOUNT_ONE);
  await client.clearProviderDefault('claude');
  await client.deleteAccount(ACCOUNT_ONE);

  assert.deepEqual(transport.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v1/management/accounts' },
    { method: 'PATCH', path: `/v1/management/accounts/${ACCOUNT_ONE}` },
    { method: 'PUT', path: `/v1/management/accounts/${ACCOUNT_ONE}/credential` },
    { method: 'GET', path: '/v1/management/account-defaults/claude' },
    { method: 'PUT', path: '/v1/management/account-defaults/claude' },
    { method: 'DELETE', path: '/v1/management/account-defaults/claude' },
    { method: 'DELETE', path: `/v1/management/accounts/${ACCOUNT_ONE}` }
  ]);
  assert.deepEqual(transport.requests[0]?.body, {
    provider_id: 'claude',
    auth: {
      kind: 'auth_token',
      auth_token: 'claude-static-token',
      base_url: 'https://api.example.test'
    }
  });
  assert.deepEqual(transport.requests[2]?.body, {
    auth: { kind: 'api_key', api_key: 'claude-api-key' }
  });
  assert.deepEqual(transport.requests[4]?.body, { account_ref: ACCOUNT_ONE });
  await assert.rejects(
    client.createStaticAccount('codex', { kind: 'auth_token', authToken: 'not-supported' }),
    /account_management_auth_kind_unsupported/
  );
});

test('OAuth 注册、查询、回调和取消保持一次性 URL 与 Job 状态合同', async () => {
  const pending = oauthJob('pending');
  const completed = {
    ...oauthJob('completed'),
    finished_at: '2026-08-15T01:02:05Z',
    account_ref: ACCOUNT_ONE,
    cli_account_id: 1
  };
  const cancelled = {
    ...oauthJob('cancelled'),
    finished_at: '2026-08-15T01:02:06Z'
  };
  const transport = new FakeTransport([
    json(201, {
      data: {
        ...pending,
        authorization_url: 'https://auth.example.test/authorize?state=opaque'
      }
    }),
    json(200, { data: pending }),
    json(200, { data: completed }),
    json(200, { data: cancelled })
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  const started = await client.startOAuthJob('codex');
  const current = await client.getOAuthJob(JOB_ID);
  const result = await client.completeOAuthJob(
    JOB_ID,
    'http://localhost:1455/auth/callback?code=opaque&state=opaque'
  );
  const cancelledResult = await client.cancelOAuthJob(JOB_ID);

  assert.equal(started.authorizationUrl, 'https://auth.example.test/authorize?state=opaque');
  assert.equal(current.status, 'pending');
  assert.equal(result.accountRef, ACCOUNT_ONE);
  assert.equal(cancelledResult.status, 'cancelled');
  assert.deepEqual(transport.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v1/management/account-auth-jobs' },
    { method: 'GET', path: `/v1/management/account-auth-jobs/${JOB_ID}` },
    { method: 'POST', path: `/v1/management/account-auth-jobs/${JOB_ID}/callback` },
    { method: 'DELETE', path: `/v1/management/account-auth-jobs/${JOB_ID}` }
  ]);
  assert.deepEqual(transport.requests[0]?.body, { provider_id: 'codex' });
  assert.deepEqual(transport.requests[2]?.body, {
    callback: 'http://localhost:1455/auth/callback?code=opaque&state=opaque'
  });
});

test('显式 usage 刷新、原生导入、sub2api 导入和导出保持单账号边界', async () => {
  const transport = new FakeTransport([
    json(200, {
      data: {
        account_ref: ACCOUNT_ONE,
        provider_id: 'codex',
        source: 'openai-status',
        captured_at: '2026-08-15T01:03:00Z',
        stale: false,
        entries: [{
          limit_id: 'five_hour',
          limit_name: '5 hours',
          bucket: 'primary',
          kind: 'window',
          scope: 'account',
          scope_key: '',
          remaining_basis_points: 7200,
          availability: 'available',
          window_seconds: 18000,
          reset_at: '2026-08-15T05:00:00Z'
        }]
      }
    }),
    json(201, envelope(account(ACCOUNT_ONE, 'codex', 1))),
    json(200, envelope(account(ACCOUNT_TWO, 'claude', 2)))
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  const usage = await client.refreshUsage(ACCOUNT_ONE);
  const createdImport = await client.importNativeAccount({
    providerId: 'codex',
    artifacts: { auth_json: { tokens: { access_token: 'opaque' } } }
  });
  const updatedImport = await client.importSub2APIAccount({ type: 'sub2api-data', accounts: [] });
  const exported = await client.exportSub2APIAccount(ACCOUNT_ONE);

  assert.equal(usage.entries[0]?.remainingBasisPoints, 7200);
  assert.equal(createdImport.created, true);
  assert.equal(createdImport.account.accountRef, ACCOUNT_ONE);
  assert.equal(updatedImport.created, false);
  assert.equal(updatedImport.account.accountRef, ACCOUNT_TWO);
  assert.equal(exported.size, 2);
  assert.deepEqual(transport.requests.map(({ method, path, port }) => ({ method, path, port })), [
    { method: 'POST', path: `/v1/management/accounts/${ACCOUNT_ONE}/usage/refresh`, port: 'json' },
    { method: 'POST', path: '/v1/management/account-imports', port: 'json' },
    { method: 'POST', path: '/v1/management/account-imports/sub2api', port: 'json' },
    { method: 'GET', path: `/v1/management/accounts/${ACCOUNT_ONE}/export`, port: 'blob' }
  ]);
});

test('单账号导出拒绝尺寸、媒体类型和附件文件名异常且不泄露 body', async () => {
  const secret = 'synthetic-export-body-secret';
  const validHeaders = {
    contentType: 'application/json; charset=utf-8',
    contentDisposition: 'attachment; filename="sub2api-data.json"'
  };
  const cases: ServerBlobResponse[] = [
    {
      headers: validHeaders,
      data: new Blob(['{}'], { type: 'application/json' }),
      size: 1
    },
    {
      headers: validHeaders,
      data: new Blob([], { type: 'application/json' }),
      size: 0
    },
    {
      headers: validHeaders,
      data: new Blob([new Uint8Array((1024 * 1024) + 1)], { type: 'application/json' }),
      size: (1024 * 1024) + 1
    },
    {
      headers: { ...validHeaders, contentType: 'text/html' },
      data: new Blob([secret], { type: 'text/html' }),
      size: secret.length
    },
    {
      headers: { ...validHeaders, contentDisposition: 'inline; filename="sub2api-data.json"' },
      data: new Blob(['{}'], { type: 'application/json' }),
      size: 2
    },
    {
      headers: { ...validHeaders, contentDisposition: 'attachment; filename="accounts.json"' },
      data: new Blob(['{}'], { type: 'application/json' }),
      size: 2
    }
  ];

  for (const blobResponse of cases) {
    const transport = new FakeTransport([], blobResponse);
    const error = await new AccountManagementClient({
      transport,
      profileId: 'profile-local'
    }).exportSub2APIAccount(ACCOUNT_ONE).then(
      () => null,
      (caught: unknown) => caught
    );
    assert.ok(error instanceof AccountManagementError);
    assert.match(String(error), /account_management_export_response_invalid/);
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  }
});

test('单账号模型列表与手动刷新使用 Go 模型子资源并严格解码完整关系', async () => {
  const models = {
    data: [{
      model_id: 'gpt-5.6-sol',
      upstream_available: true,
      manual_policy: 'inherit',
      effective: true,
      updated_at: '2026-08-15T01:04:00Z'
    }]
  };
  const transport = new FakeTransport([
    json(200, models),
    json(200, {
      data: [{
        ...models.data[0],
        manual_policy: 'force_disable',
        effective: false
      }]
    }),
    json(200, {
      data: [{
        ...models.data[0],
        manual_policy: 'force_enable',
        effective: true
      }]
    })
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  const listed = await client.listAccountModels(ACCOUNT_ONE);
  const refreshed = await client.refreshAccountModels(ACCOUNT_ONE);
  const policyUpdated = await client.setAccountModelPolicy(
    ACCOUNT_ONE,
    'gpt-5.6-sol',
    'force_enable'
  );

  assert.equal(listed[0]?.modelId, 'gpt-5.6-sol');
  assert.equal(listed[0]?.effective, true);
  assert.equal(refreshed[0]?.manualPolicy, 'force_disable');
  assert.equal(refreshed[0]?.effective, false);
  assert.equal(policyUpdated[0]?.manualPolicy, 'force_enable');
  assert.deepEqual(transport.requests.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: `/v1/management/accounts/${ACCOUNT_ONE}/models` },
    { method: 'POST', path: `/v1/management/accounts/${ACCOUNT_ONE}/models/refresh` },
    { method: 'PATCH', path: `/v1/management/accounts/${ACCOUNT_ONE}/models` }
  ]);
  assert.deepEqual(transport.requests[2]?.body, {
    model_id: 'gpt-5.6-sol',
    manual_policy: 'force_enable'
  });
});

test('模型策略写入拒绝非法模型身份和未知策略且不发送请求', async () => {
  const transport = new FakeTransport([]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  await assert.rejects(
    client.setAccountModelPolicy(ACCOUNT_ONE, 'gpt 5.6', 'inherit'),
    /account_management_model_id_invalid/
  );
  await assert.rejects(
    client.setAccountModelPolicy(ACCOUNT_ONE, 'gpt-5.6-sol', 'automatic' as never),
    /account_management_model_policy_invalid/
  );
  assert.equal(transport.requests.length, 0);
});

test('模型 decoder 拒绝重复 ID、未知策略和带空白的模型身份', async () => {
  const invalidDocuments = [
    {
      data: [model('gpt-5.6-sol'), model('gpt-5.6-sol')]
    },
    {
      data: [{ ...model('gpt-5.6-sol'), manual_policy: 'automatic' }]
    },
    {
      data: [model('gpt 5.6')]
    }
  ];
  for (const document of invalidDocuments) {
    const transport = new FakeTransport([json(200, document)]);
    await assert.rejects(
      new AccountManagementClient({ transport, profileId: 'profile-local' })
        .listAccountModels(ACCOUNT_ONE),
      /account_management_model_/
    );
  }
});

test('账号投影显式保留未知运行态且不伪造 usage 或 mobile', () => {
  const projected = projectAccountView(decodedAccount(), {
    defaultAccountRefs: new Set([ACCOUNT_ONE])
  });

  assert.equal(projected.accountRef, ACCOUNT_ONE);
  assert.equal(projected.runtimeStatus, 'unknown');
  assert.equal(projected.schedulableStatus, 'unknown');
  assert.equal(projected.quotaStatus, 'unknown');
  assert.equal(projected.remainingPct, null);
  assert.equal(projected.usageSnapshot, null);
  assert.equal(projected.isMobile, false);
  assert.equal(projected.isDefault, true);
});

test('冷启动列表直接投影 aih.db 的 usage 与模型 last-known-good，不发逐账号请求', async () => {
  const persisted = {
    ...account(ACCOUNT_ONE, 'codex', 1),
    model_summary: {
      stored_count: 3,
      effective_count: 2,
      updated_at: '2026-08-15T01:04:00Z'
    },
    usage_snapshot: {
      source: 'codex_wham_usage',
      captured_at: '2026-08-15T01:03:00Z',
      entries: [{
        limit_id: '',
        limit_name: '',
        bucket: 'primary',
        kind: 'window',
        scope: 'account',
        scope_key: '',
        remaining_basis_points: 7_500,
        availability: 'available',
        window_seconds: 18_000,
        reset_at: '2026-08-15T05:00:00Z'
      }]
    }
  };
  const transport = new FakeTransport([
    json(200, accountPage([persisted], false, ''))
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  const [source] = await client.listAllAccounts();
  const projected = projectAccountView(source!);

  assert.equal(projected.remainingPct, 75);
  assert.equal(projected.updatedAt, Date.parse('2026-08-15T01:03:00Z'));
  assert.equal(projected.usageSnapshot?.kind, 'codex_oauth_status');
  assert.equal(projected.usageSnapshot?.entries[0]?.windowMinutes, 300);
  assert.equal(projected.usageSnapshot?.entries[0]?.resetAtMs, Date.parse('2026-08-15T05:00:00Z'));
  assert.deepEqual(projected.modelSummary, {
    storedCount: 3,
    effectiveCount: 2,
    updatedAt: Date.parse('2026-08-15T01:04:00Z')
  });
  assert.deepEqual(transport.requests.map(({ path }) => path), [
    '/v1/management/accounts?limit=255'
  ]);
});

test('账号列表严格拒绝伪模型汇总和矛盾 usage，而 null 保持 unknown', async () => {
  const invalidAccounts = [
    {
      ...account(ACCOUNT_ONE, 'codex', 1),
      model_summary: {
        stored_count: 1,
        effective_count: 2,
        updated_at: '2026-08-15T01:04:00Z'
      }
    },
    {
      ...account(ACCOUNT_ONE, 'codex', 1),
      usage_snapshot: {
        source: 'codex_wham_usage',
        captured_at: '2026-08-15T01:03:00Z',
        entries: [{
          limit_id: '',
          limit_name: '',
          bucket: 'primary',
          kind: 'window',
          scope: 'account',
          scope_key: '',
          remaining_basis_points: 0,
          availability: 'available',
          window_seconds: null,
          reset_at: null
        }]
      }
    }
  ];
  for (const invalid of invalidAccounts) {
    const transport = new FakeTransport([json(200, accountPage([invalid], false, ''))]);
    await assert.rejects(
      new AccountManagementClient({ transport, profileId: 'profile-local' }).listAllAccounts(),
      /account_management_(account_model|usage_)/
    );
  }

  const transport = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'codex', 1)], false, ''))
  ]);
  const [source] = await new AccountManagementClient({
    transport,
    profileId: 'profile-local'
  }).listAllAccounts();
  const projected = projectAccountView(source!);
  assert.equal(projected.remainingPct, null);
  assert.equal(projected.usageSnapshot, null);
  assert.equal(projected.modelSummary, undefined);
});

test('错误解码和格式化不会包含 API Key、Token 或服务端原始 message', async () => {
  const secret = 'synthetic-secret-must-not-leak';
  const transport = new FakeTransport([
    json(422, { error: { code: 'invalid_request', message: `invalid key ${secret}` } })
  ]);
  const client = new AccountManagementClient({ transport, profileId: 'profile-local' });

  const error = await client.createStaticAccount('codex', {
    kind: 'api_key', apiKey: secret
  }).then(
    () => null,
    (caught: unknown) => caught
  );

  assert.ok(error instanceof AccountManagementError);
  assert.doesNotMatch(String(error), new RegExp(secret));
  assert.doesNotMatch(formatAccountManagementError(error), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
  assert.equal((error as AccountManagementError).status, 422);
});

test('严格 decoder 拒绝停滞游标、重复账号和恶意 Provider，但跳过安全的非 G1 Provider', async () => {
  const invalidCursor = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'codex', 1)], true, ACCOUNT_TWO))
  ]);
  await assert.rejects(
    new AccountManagementClient({ transport: invalidCursor, profileId: 'profile-local' })
      .listAllAccounts(),
    /account_management_accounts_cursor_invalid/
  );

  const duplicate = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'codex', 1)], true, ACCOUNT_ONE)),
    json(200, accountPage([account(ACCOUNT_ONE, 'codex', 1)], false, ''))
  ]);
  await assert.rejects(
    new AccountManagementClient({ transport: duplicate, profileId: 'profile-local' })
      .listAllAccounts(),
    /account_management_accounts_duplicate/
  );

  const unsupportedProvider = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'gemini', 1)], true, ACCOUNT_ONE)),
    json(200, accountPage([account(ACCOUNT_TWO, 'claude', 2)], false, ''))
  ]);
  const managed = await new AccountManagementClient({
    transport: unsupportedProvider,
    profileId: 'profile-local'
  }).listAllAccounts();
  assert.deepEqual(managed.map(({ accountRef }) => accountRef), [ACCOUNT_TWO]);

  const maliciousProvider = new FakeTransport([
    json(200, accountPage([account(ACCOUNT_ONE, 'codex/../../secret', 1)], false, ''))
  ]);
  await assert.rejects(
    new AccountManagementClient({ transport: maliciousProvider, profileId: 'profile-local' })
      .listAllAccounts(),
    /account_management_provider_invalid/
  );
});

test('账号页在跳过非 G1 Provider 前仍拒绝 account_ref 重复或乱序', async () => {
  const invalidPages = [
    accountPage([
      account(ACCOUNT_TWO, 'gemini', 2),
      account(ACCOUNT_ONE, 'codex', 1)
    ], false, ''),
    accountPage([
      account(ACCOUNT_ONE, 'gemini', 1),
      account(ACCOUNT_ONE, 'claude', 2)
    ], false, '')
  ];

  for (const page of invalidPages) {
    const transport = new FakeTransport([json(200, page)]);
    await assert.rejects(
      new AccountManagementClient({ transport, profileId: 'profile-local' }).listAllAccounts(),
      /account_management_accounts_order_invalid/
    );
  }
});

test('无凭据账号要求 auth_kind 和 auth_mode 同时为空', async () => {
  const validDocument = {
    ...account(ACCOUNT_ONE, 'codex', 1),
    has_credential: false,
    auth_kind: '',
    auth_mode: ''
  };
  const validTransport = new FakeTransport([json(200, envelope(validDocument))]);
  const valid = await new AccountManagementClient({
    transport: validTransport,
    profileId: 'profile-local'
  }).getAccount(ACCOUNT_ONE);
  assert.equal(valid.hasCredential, false);
  assert.equal(valid.authKind, '');
  assert.equal(valid.authMode, '');

  const invalidDocuments = [
    { ...validDocument, auth_kind: 'api_key' },
    { ...validDocument, auth_mode: 'refreshable' }
  ];
  for (const document of invalidDocuments) {
    const transport = new FakeTransport([json(200, envelope(document))]);
    await assert.rejects(
      new AccountManagementClient({ transport, profileId: 'profile-local' })
        .getAccount(ACCOUNT_ONE),
      /account_management_account_credential_invalid/
    );
  }
});

function json(status: number, data: unknown): QueuedJsonResponse {
  return { status, data };
}

function envelope(data: Record<string, unknown>) {
  return { data };
}

function accountPage(data: Record<string, unknown>[], hasMore: boolean, nextAfterRef: string) {
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

function decodedAccount() {
  return {
    accountRef: ACCOUNT_ONE,
    providerId: 'codex' as const,
    cliAccountId: 1,
    enabled: true,
    hasCredential: true,
    authKind: 'oauth',
    authMode: 'refreshable',
    hasProfile: true,
    displayName: 'Codex Plus',
    email: 'codex@example.test',
    subscriptionKind: 'plus',
    subscriptionRaw: 'plus',
    profileUpdatedAt: '2026-08-15T01:00:00Z',
    modelSummary: null,
    usageSnapshot: null,
    createdAt: '2026-08-15T01:00:00Z',
    updatedAt: '2026-08-15T01:01:00Z'
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

function model(modelId: string): Record<string, unknown> {
  return {
    model_id: modelId,
    upstream_available: true,
    manual_policy: 'inherit',
    effective: true,
    updated_at: '2026-08-15T01:04:00Z'
  };
}
