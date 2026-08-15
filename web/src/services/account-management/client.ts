import type {
  ServerBlobResponse,
  ServerJsonResponse,
  ServerJsonValue,
  ServerRequest,
  ServerTransport
} from '../server-transport/contract.ts';
import {
  assertAccountRef,
  assertAccountModelId,
  assertAccountModelManualPolicy,
  assertManagedProvider,
  assertOAuthJobId,
  decodeAccountEnvelope,
  decodeAccountModelsEnvelope,
  decodeAccountPage,
  decodeAccountUsageEnvelope,
  decodeOAuthJobEnvelope,
  decodeOAuthJobStartEnvelope,
  decodeProviderDefaultEnvelope
} from './decoders.ts';
import {
  AccountManagementError,
  asAccountManagementError
} from './errors.ts';
import type {
  AccountImportResultView,
  AccountModelView,
  AccountUsageView,
  AccountView,
  ManagedProvider,
  NativeAccountImportInput,
  OAuthJobStartView,
  OAuthJobView,
  ProviderDefaultView,
  StaticCredentialInput
} from './types.ts';

const ACCOUNTS_PATH = '/v1/management/accounts';
const DEFAULTS_PATH = '/v1/management/account-defaults';
const OAUTH_JOBS_PATH = '/v1/management/account-auth-jobs';
const NATIVE_IMPORT_PATH = '/v1/management/account-imports';
const SUB2API_IMPORT_PATH = '/v1/management/account-imports/sub2api';
const ACCOUNT_PAGE_SIZE = 255;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EXPORT_BYTES = 1024 * 1024;
const SUB2API_EXPORT_FILENAME = 'sub2api-data.json';

// AccountManagementTransport 是账号客户端实际依赖的最小传输端口。
export type AccountManagementTransport = Pick<
  ServerTransport,
  'requestJson' | 'requestBlob'
>;

// AccountManagementClientOptions 显式注入 active profile 身份和传输实现。
export interface AccountManagementClientOptions {
  transport: AccountManagementTransport;
  profileId: string;
  timeoutMs?: number;
}

// AccountManagementClient 是 WebUI 到 Go 账号应用层的唯一 HTTP 客户端。
export class AccountManagementClient {
  private readonly transport: AccountManagementTransport;
  private readonly profileId: string;
  private readonly timeoutMs: number;

  constructor(options: AccountManagementClientOptions) {
    this.transport = options.transport;
    this.profileId = String(options.profileId || '').trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.transport || !this.profileId || /[\r\n\0]/.test(this.profileId)) {
      throw new AccountManagementError('account_management_client_options_invalid');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120_000) {
      throw new AccountManagementError('account_management_timeout_invalid');
    }
  }

  // listAllAccounts 顺序读取完整 keyset，绝不为 usage 或运行态制造 N+1 请求。
  async listAllAccounts(): Promise<AccountView[]> {
    const accounts: AccountView[] = [];
    const accountRefs = new Set<string>();
    const visitedCursors = new Set<string>();
    let afterRef = '';
    while (true) {
      const query = new URLSearchParams({ limit: String(ACCOUNT_PAGE_SIZE) });
      if (afterRef) query.set('after_ref', afterRef);
      const response = await this.requestJson('GET', `${ACCOUNTS_PATH}?${query.toString()}`);
      this.assertStatus(response, [200]);
      const decoded = decodeAccountPage(response.data);
      for (const account of decoded.data) {
        if (accountRefs.has(account.accountRef)) {
          throw new AccountManagementError('account_management_accounts_duplicate');
        }
        accountRefs.add(account.accountRef);
        accounts.push(account);
      }
      if (!decoded.page.hasMore) return accounts;
      if (visitedCursors.has(decoded.page.nextAfterRef)) {
        throw new AccountManagementError('account_management_accounts_cursor_stalled');
      }
      visitedCursors.add(decoded.page.nextAfterRef);
      afterRef = decoded.page.nextAfterRef;
    }
  }

  // createStaticAccount 创建 Codex API Key、Claude API Key 或 Claude Auth Token 账号。
  async createStaticAccount(
    providerId: ManagedProvider,
    credential: StaticCredentialInput
  ): Promise<AccountView> {
    assertManagedProvider(providerId);
    const auth = this.staticCredentialBody(providerId, credential);
    const response = await this.requestJson('POST', ACCOUNTS_PATH, {
      provider_id: providerId,
      auth
    });
    this.assertStatus(response, [201]);
    return decodeAccountEnvelope(response.data);
  }

  // getAccount 只在用户完成单账号变更后读取该账号，不参与列表批量加载。
  async getAccount(accountRef: string): Promise<AccountView> {
    const response = await this.requestJson('GET', this.accountPath(accountRef));
    this.assertStatus(response, [200]);
    return decodeAccountEnvelope(response.data);
  }

  // setAccountEnabled 幂等设置账号是否参与运行时征召。
  async setAccountEnabled(accountRef: string, enabled: boolean): Promise<AccountView> {
    const path = this.accountPath(accountRef);
    const response = await this.requestJson('PATCH', path, { enabled });
    this.assertStatus(response, [200]);
    return decodeAccountEnvelope(response.data);
  }

  // rotateCredential 在原 AccountRef 上完整替换静态凭据。
  async rotateCredential(
    accountRef: string,
    providerId: ManagedProvider,
    credential: StaticCredentialInput
  ): Promise<AccountView> {
    const path = `${this.accountPath(accountRef)}/credential`;
    const auth = this.staticCredentialBody(providerId, credential);
    const response = await this.requestJson('PUT', path, { auth });
    this.assertStatus(response, [200]);
    return decodeAccountEnvelope(response.data);
  }

  // deleteAccount 只删除调用方明确给出的稳定 AccountRef。
  async deleteAccount(accountRef: string): Promise<void> {
    const response = await this.requestJson('DELETE', this.accountPath(accountRef));
    this.assertStatus(response, [204]);
    if (response.data !== null && response.data !== undefined) {
      throw new AccountManagementError('account_management_delete_response_invalid');
    }
  }

  // getProviderDefault 读取单个 Provider 默认启动账号关系。
  async getProviderDefault(providerId: ManagedProvider): Promise<ProviderDefaultView> {
    const response = await this.requestJson('GET', this.providerDefaultPath(providerId));
    this.assertStatus(response, [200]);
    return decodeProviderDefaultEnvelope(response.data);
  }

  // setProviderDefault 完整替换单个 Provider 默认启动账号关系。
  async setProviderDefault(
    providerId: ManagedProvider,
    accountRef: string
  ): Promise<ProviderDefaultView> {
    assertAccountRef(accountRef);
    const response = await this.requestJson('PUT', this.providerDefaultPath(providerId), {
      account_ref: accountRef
    });
    this.assertStatus(response, [200]);
    return decodeProviderDefaultEnvelope(response.data);
  }

  // clearProviderDefault 幂等清除单个 Provider 默认关系。
  async clearProviderDefault(providerId: ManagedProvider): Promise<void> {
    const response = await this.requestJson('DELETE', this.providerDefaultPath(providerId));
    this.assertStatus(response, [204]);
    if (response.data !== null && response.data !== undefined) {
      throw new AccountManagementError('account_management_default_delete_response_invalid');
    }
  }

  // startOAuthJob 创建新账号或已有账号 reauth 的短期 OAuth Job。
  async startOAuthJob(
    providerId: ManagedProvider,
    targetAccountRef?: string
  ): Promise<OAuthJobStartView> {
    assertManagedProvider(providerId);
    if (targetAccountRef !== undefined) assertAccountRef(targetAccountRef);
    const response = await this.requestJson('POST', OAUTH_JOBS_PATH, {
      provider_id: providerId,
      ...(targetAccountRef ? { target_account_ref: targetAccountRef } : {})
    });
    this.assertStatus(response, [201]);
    return decodeOAuthJobStartEnvelope(response.data);
  }

  // getOAuthJob 读取一个 OAuth Job 的非敏感状态快照。
  async getOAuthJob(jobId: string): Promise<OAuthJobView> {
    const response = await this.requestJson('GET', this.oauthJobPath(jobId));
    this.assertStatus(response, [200]);
    return decodeOAuthJobEnvelope(response.data);
  }

  // cancelOAuthJob 取消仍在等待回调的 OAuth Job。
  async cancelOAuthJob(jobId: string): Promise<OAuthJobView> {
    const response = await this.requestJson('DELETE', this.oauthJobPath(jobId));
    this.assertStatus(response, [200]);
    return decodeOAuthJobEnvelope(response.data);
  }

  // completeOAuthJob 将浏览器回调原样交给 Go Provider 适配器消费。
  async completeOAuthJob(jobId: string, callback: string): Promise<OAuthJobView> {
    const value = String(callback || '');
    if (!value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
      throw new AccountManagementError('account_management_oauth_callback_invalid');
    }
    const response = await this.requestJson(
      'POST',
      `${this.oauthJobPath(jobId)}/callback`,
      { callback: value }
    );
    this.assertStatus(response, [200]);
    return decodeOAuthJobEnvelope(response.data);
  }

  // refreshUsage 是明确的用户动作；账号列表不会隐式调用它。
  async refreshUsage(accountRef: string): Promise<AccountUsageView> {
    const response = await this.requestJson(
      'POST',
      `${this.accountPath(accountRef)}/usage/refresh`
    );
    this.assertStatus(response, [200]);
    return decodeAccountUsageEnvelope(response.data);
  }

  // listAccountModels 只在页面明确展开一个账号时读取，不参与账号列表 N+1。
  async listAccountModels(accountRef: string): Promise<AccountModelView[]> {
    const response = await this.requestJson('GET', `${this.accountPath(accountRef)}/models`);
    this.assertStatus(response, [200]);
    return decodeAccountModelsEnvelope(response.data);
  }

  // refreshAccountModels 同步返回 Go 已持久化的新快照，不伪装为后台 Job。
  async refreshAccountModels(accountRef: string): Promise<AccountModelView[]> {
    const response = await this.requestJson(
      'POST',
      `${this.accountPath(accountRef)}/models/refresh`
    );
    this.assertStatus(response, [200]);
    return decodeAccountModelsEnvelope(response.data);
  }

  // setAccountModelPolicy 原子更新单个账号模型的人工策略并返回完整快照。
  async setAccountModelPolicy(
    accountRef: string,
    modelId: string,
    manualPolicy: AccountModelView['manualPolicy']
  ): Promise<AccountModelView[]> {
    assertAccountRef(accountRef);
    assertAccountModelId(modelId);
    assertAccountModelManualPolicy(manualPolicy);
    const response = await this.requestJson(
      'PATCH',
      `${this.accountPath(accountRef)}/models`,
      { model_id: modelId, manual_policy: manualPolicy }
    );
    this.assertStatus(response, [200]);
    return decodeAccountModelsEnvelope(response.data);
  }

  // importNativeAccount 导入一个 Codex/Claude 官方 artifact 文档。
  async importNativeAccount(input: NativeAccountImportInput): Promise<AccountImportResultView> {
    assertManagedProvider(input.providerId);
    this.assertJsonObject(input.artifacts, 'account_management_native_artifacts_invalid');
    const response = await this.requestJson('POST', NATIVE_IMPORT_PATH, {
      provider_id: input.providerId,
      artifacts: input.artifacts
    });
    this.assertStatus(response, [200, 201]);
    return {
      account: decodeAccountEnvelope(response.data),
      created: response.status === 201
    };
  }

  // importSub2APIAccount 导入一个未经 AIH 私有包装的单账号迁移文档。
  async importSub2APIAccount(document: ServerJsonValue): Promise<AccountImportResultView> {
    this.assertJsonObject(document, 'account_management_sub2api_document_invalid');
    const response = await this.requestJson('POST', SUB2API_IMPORT_PATH, document);
    this.assertStatus(response, [200, 201]);
    return {
      account: decodeAccountEnvelope(response.data),
      created: response.status === 201
    };
  }

  // exportSub2APIAccount 下载标准单账号迁移文档，不解析或重写其字段。
  async exportSub2APIAccount(accountRef: string): Promise<ServerBlobResponse> {
    try {
      const response = await this.transport.requestBlob({
        profileId: this.profileId,
        method: 'GET',
        path: `${this.accountPath(accountRef)}/export`,
        timeoutMs: this.timeoutMs
      });
      this.assertSub2APIExportResponse(response);
      return response;
    } catch (error) {
      throw asAccountManagementError(error);
    }
  }

  // assertSub2APIExportResponse 只校验非敏感元数据，不读取或拼接导出 body。
  private assertSub2APIExportResponse(response: ServerBlobResponse): void {
    const size = response?.size;
    const contentType = String(response?.headers?.contentType || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const contentDisposition = String(response?.headers?.contentDisposition || '').trim();
    const dispositionMatch = /^attachment;\s*filename="([^"]+)"$/i.exec(contentDisposition);
    if (
      !(response?.data instanceof Blob)
      || !Number.isSafeInteger(size)
      || size < 1
      || size > MAX_EXPORT_BYTES
      || response.data.size !== size
      || contentType !== 'application/json'
      || dispositionMatch?.[1] !== SUB2API_EXPORT_FILENAME
    ) {
      throw new AccountManagementError('account_management_export_response_invalid');
    }
  }

  private staticCredentialBody(
    providerId: ManagedProvider,
    credential: StaticCredentialInput
  ): Record<string, ServerJsonValue> {
    assertManagedProvider(providerId);
    if (credential.kind === 'auth_token' && providerId !== 'claude') {
      throw new AccountManagementError('account_management_auth_kind_unsupported');
    }
    const baseUrl = this.requiredCredentialText(
      credential.baseUrl || '',
      4096,
      true,
      'account_management_base_url_invalid'
    );
    if (credential.kind === 'api_key') {
      return {
        kind: credential.kind,
        api_key: this.requiredCredentialText(
          credential.apiKey,
          16_384,
          false,
          'account_management_api_key_invalid'
        ),
        ...(baseUrl ? { base_url: baseUrl } : {})
      };
    }
    return {
      kind: credential.kind,
      auth_token: this.requiredCredentialText(
        credential.authToken,
        16_384,
        false,
        'account_management_auth_token_invalid'
      ),
      ...(baseUrl ? { base_url: baseUrl } : {})
    };
  }

  private requiredCredentialText(
    value: string,
    maxLength: number,
    allowEmpty: boolean,
    code: string
  ): string {
    const text = String(value || '');
    if ((!allowEmpty && !text) || text.length > maxLength || /[\r\n\0]/.test(text)) {
      throw new AccountManagementError(code);
    }
    return text;
  }

  // assertJsonObject 拒绝标量和数组，避免把错误迁移文档发送到 Go 解码器。
  private assertJsonObject(value: ServerJsonValue, code: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AccountManagementError(code);
    }
  }

  private accountPath(accountRef: string): string {
    assertAccountRef(accountRef);
    return `${ACCOUNTS_PATH}/${accountRef}`;
  }

  private providerDefaultPath(providerId: ManagedProvider): string {
    assertManagedProvider(providerId);
    return `${DEFAULTS_PATH}/${providerId}`;
  }

  private oauthJobPath(jobId: string): string {
    assertOAuthJobId(jobId);
    return `${OAUTH_JOBS_PATH}/${jobId}`;
  }

  private async requestJson<TBody = ServerJsonValue>(
    method: ServerRequest<TBody>['method'],
    path: string,
    body?: TBody
  ): Promise<ServerJsonResponse<unknown>> {
    try {
      return await this.transport.requestJson<unknown, TBody>({
        profileId: this.profileId,
        method,
        path,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      throw asAccountManagementError(error);
    }
  }

  private assertStatus(response: ServerJsonResponse<unknown>, allowed: readonly number[]): void {
    if (allowed.includes(response.status)) return;
    // 服务端错误 body 可能来自上游，客户端只保留状态，避免 message/code 携带凭据。
    throw new AccountManagementError(`account_management_http_${response.status}`, response.status);
  }
}
