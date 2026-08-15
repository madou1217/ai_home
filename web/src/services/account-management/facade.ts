import type {
  Account,
  AccountAddJob,
  AccountImportJob,
  AccountImportResponse,
  AccountRefreshUsageResponse,
  AccountsListResponse,
  AccountsSnapshotRequestResponse,
  AddAccountRequest,
  AddAccountResponse
} from '../../types/index.ts';
import type { ServerBlobResponse } from '../server-transport/contract.ts';
import { downloadBrowserBlob } from './browser-download.ts';
import { AccountManagementClient } from './client.ts';
import { assertAccountRef, assertOAuthJobId } from './decoders.ts';
import { AccountManagementError, unsupportedAccountOperation } from './errors.ts';
import { decodeLegacySub2APIImport } from './import-policy.ts';
import type {
  AccountExportFormat,
  AccountImportPayload,
  AccountsWatchHandlers
} from './legacy-contract.ts';
import {
  asManagedProvider,
  assertAccountIdentity,
  projectOAuthJob,
  projectOAuthStart,
  projectUsageRefreshJob,
  replacementCredentialFromLegacy,
  staticCredentialFromLegacy
} from './legacy-mappers.ts';
import { projectAccountView, projectAccountViews } from './projection.ts';
import type {
  AccountModelView,
  AccountView,
  ManagedProvider
} from './types.ts';
import {
  AccountWatchCoordinator,
  type TimerScheduler,
  type VisibilitySource
} from './watch-coordinator.ts';

const MANAGED_PROVIDERS = ['codex', 'claude'] as const satisfies readonly ManagedProvider[];

export interface AccountManagementFacadeOptions {
  clientFactory?: () => Promise<AccountManagementClient>;
  now?: () => number;
  pollIntervalMs?: number;
  visibility?: VisibilitySource | null;
  scheduler?: TimerScheduler;
  downloadBlob?: (response: ServerBlobResponse, filename: string) => Promise<void>;
}

// AccountManagementFacade 是旧页面 DTO 与 Go Management API 之间唯一的防腐层。
export class AccountManagementFacade {
  private readonly clientFactory: () => Promise<AccountManagementClient>;
  private readonly now: () => number;
  private readonly downloadBlob: (response: ServerBlobResponse, filename: string) => Promise<void>;
  private readonly watches: AccountWatchCoordinator;
  private readonly accountViews = new Map<string, AccountView>();
  private readonly defaultAccountRefs = new Set<string>();
  // 删除是破坏性操作；同一页面内的重复触发共享一个请求，避免重复写入。
  private readonly pendingDeletes = new Map<string, Promise<void>>();
  private readonly completedOAuthJobs = new Set<string>();
  private readonly oauthAuthorizationUrls = new Map<string, string>();
  private snapshotRead: Promise<AccountsListResponse> | null = null;

  constructor(options: AccountManagementFacadeOptions = {}) {
    this.clientFactory = options.clientFactory || defaultClientFactory;
    this.now = options.now || Date.now;
    this.downloadBlob = options.downloadBlob || downloadBrowserBlob;
    this.watches = new AccountWatchCoordinator({
      loadSnapshot: () => this.list(),
      now: this.now,
      ...(options.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.pollIntervalMs }
        : {}),
      ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {})
    });
  }

  // list 并行读取 Codex/Claude 默认关系，账号本体仍使用完整 keyset。
  async list(): Promise<AccountsListResponse> {
    if (this.snapshotRead) return this.snapshotRead;
    const read = this.loadSnapshot();
    this.snapshotRead = read;
    try {
      return await read;
    } finally {
      if (this.snapshotRead === read) this.snapshotRead = null;
    }
  }

  watch(handlers: AccountsWatchHandlers) {
    return this.watches.watch(handlers);
  }

  async add(payload: AddAccountRequest): Promise<AddAccountResponse> {
    const provider = asManagedProvider(payload.provider);
    if (payload.replaceExisting) {
      unsupportedAccountOperation('account_management_replace_oauth_job_unsupported');
    }
    if (payload.authMode === 'oauth-browser') {
      if (payload.config && Object.keys(payload.config).length > 0) {
        throw new AccountManagementError('account_management_oauth_config_invalid', 422);
      }
      const client = await this.clientFactory();
      const job = await client.startOAuthJob(provider);
      this.oauthAuthorizationUrls.set(job.jobId, job.authorizationUrl);
      this.watches.emitAuthJob(projectOAuthJob(job, job.authorizationUrl));
      return projectOAuthStart(job);
    }
    if (payload.authMode === 'oauth-device') {
      return unsupportedAccountOperation('account_management_oauth_device_unsupported');
    }
    if (payload.authMode === 'vertex-ai') {
      return unsupportedAccountOperation('account_management_vertex_ai_unsupported');
    }

    const credential = staticCredentialFromLegacy(provider, payload);
    const client = await this.clientFactory();
    const created = await client.createStaticAccount(provider, credential);
    assertAccountIdentity(created, provider);
    this.emitAccountChange(created);
    return {
      ok: true,
      provider,
      accountRef: created.accountRef,
      authMode: payload.authMode,
      status: 'configured'
    };
  }

  async getAddJob(jobId: string): Promise<AccountAddJob> {
    const client = await this.clientFactory();
    const source = await client.getOAuthJob(jobId);
    const job = projectOAuthJob(source, this.oauthAuthorizationUrls.get(source.jobId));
    this.watches.emitAuthJob(job);
    if (source.status === 'completed' && !this.completedOAuthJobs.has(source.jobId)) {
      this.completedOAuthJobs.add(source.jobId);
      this.watches.notifyMutation();
    }
    if (source.status !== 'pending' && source.status !== 'processing') {
      this.oauthAuthorizationUrls.delete(source.jobId);
    }
    return job;
  }

  async cancelAddJob(jobId: string): Promise<{ ok: true; job: AccountAddJob }> {
    const client = await this.clientFactory();
    const source = await client.cancelOAuthJob(jobId);
    const job = projectOAuthJob(source, this.oauthAuthorizationUrls.get(source.jobId));
    this.oauthAuthorizationUrls.delete(source.jobId);
    this.watches.emitAuthJob(job);
    return { ok: true, job };
  }

  async confirmCliInstall(jobId: string): Promise<AccountAddJob> {
    assertOAuthJobId(jobId);
    return unsupportedAccountOperation('account_management_cli_install_unsupported');
  }

  async completeBrowserCallback(jobId: string, callbackUrl: string): Promise<AccountAddJob> {
    const client = await this.clientFactory();
    const source = await client.completeOAuthJob(jobId, callbackUrl);
    const job = projectOAuthJob(source, this.oauthAuthorizationUrls.get(source.jobId));
    this.watches.emitAuthJob(job);
    if (source.status === 'completed') {
      this.completedOAuthJobs.add(source.jobId);
      this.watches.notifyMutation();
    }
    if (source.status !== 'pending' && source.status !== 'processing') {
      this.oauthAuthorizationUrls.delete(source.jobId);
    }
    return job;
  }

  async reauth(providerValue: string, accountRef: string): Promise<AddAccountResponse> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const job = await client.startOAuthJob(provider, accountRef);
    if (job.purpose !== 'reauth' || job.targetAccountRef !== accountRef) {
      throw new AccountManagementError('account_management_oauth_response_invalid');
    }
    this.oauthAuthorizationUrls.set(job.jobId, job.authorizationUrl);
    this.watches.emitAuthJob(projectOAuthJob(job, job.authorizationUrl));
    return projectOAuthStart(job);
  }

  async refreshUsage(
    providerValue: string,
    accountRef: string
  ): Promise<AccountRefreshUsageResponse> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const usage = await client.refreshUsage(accountRef);
    if (usage.providerId !== provider || usage.accountRef !== accountRef) {
      throw new AccountManagementError('account_management_usage_response_invalid');
    }
    const job = projectUsageRefreshJob(usage);
    this.watches.emitRefreshJob(job);
    return { ok: true, accepted: true, alreadyRunning: false, job };
  }

  requestSnapshot(): Promise<AccountsSnapshotRequestResponse> {
    return this.watches.requestSnapshot();
  }

  async updateStatus(
    providerValue: string,
    accountRef: string,
    status: 'up' | 'down'
  ): Promise<Account> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const updated = await client.setAccountEnabled(accountRef, status === 'up');
    assertAccountIdentity(updated, provider, accountRef);
    return this.emitAccountChange(updated);
  }

  async updateAccount(
    providerValue: string,
    accountRef: string,
    data: { apiKey?: string; baseUrl?: string; authMode?: string; credentialType?: string }
  ): Promise<{ ok: true; account: Account }> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const credential = replacementCredentialFromLegacy(provider, data);
    const client = await this.clientFactory();
    const updated = await client.rotateCredential(accountRef, provider, credential);
    assertAccountIdentity(updated, provider, accountRef);
    return { ok: true, account: this.emitAccountChange(updated) };
  }

  async setDefault(providerValue: string, accountRef: string): Promise<Account> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const source = await this.accountViewForMutation(client, provider, accountRef);
    const relation = await client.setProviderDefault(provider, accountRef);
    if (relation.providerId !== provider || relation.accountRef !== accountRef) {
      throw new AccountManagementError('account_management_default_response_invalid');
    }
    this.replaceProviderDefault(provider, accountRef);
    return this.emitAccountChange(source);
  }

  async clearDefault(providerValue: string, accountRef: string): Promise<Account> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const source = await this.accountViewForMutation(client, provider, accountRef);
    await client.clearProviderDefault(provider);
    this.defaultAccountRefs.delete(accountRef);
    return this.emitAccountChange(source);
  }

  async setMobile(providerValue: string, accountRef: string): Promise<Account> {
    asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    return unsupportedAccountOperation('account_management_mobile_role_unsupported');
  }

  async clearMobile(providerValue: string, accountRef: string): Promise<Account> {
    asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    return unsupportedAccountOperation('account_management_mobile_role_unsupported');
  }

  async delete(providerValue: string, accountRef: string): Promise<{ ok: true }> {
    const provider = asManagedProvider(providerValue);
    assertAccountRef(accountRef);
    const known = this.accountViews.get(accountRef);
    if (known) assertAccountIdentity(known, provider, accountRef);
    const pending = this.pendingDeletes.get(accountRef);
    if (pending) {
      await pending;
      return { ok: true };
    }
    const operation = (async () => {
      const client = await this.clientFactory();
      await client.deleteAccount(accountRef);
      this.accountViews.delete(accountRef);
      this.defaultAccountRefs.delete(accountRef);
      this.watches.emitAccountRemoved({
        provider,
        accountRef,
        reason: 'deleted',
        removedAt: this.now()
      });
      this.watches.notifyMutation();
    })();
    this.pendingDeletes.set(accountRef, operation);
    try {
      await operation;
    } finally {
      if (this.pendingDeletes.get(accountRef) === operation) {
        this.pendingDeletes.delete(accountRef);
      }
    }
    return { ok: true };
  }

  async export(_format: AccountExportFormat = 'sub2api'): Promise<void> {
    return unsupportedAccountOperation('account_management_global_export_unsupported');
  }

  async exportAccount(accountRef: string): Promise<void> {
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    const response = await client.exportSub2APIAccount(accountRef);
    await this.downloadBlob(response, `sub2api-${accountRef}.json`);
  }

  // import 是同步单账号导入；成功响应不会伪装成后台 Job。
  async import(payload: AccountImportPayload): Promise<AccountImportResponse> {
    const decoded = decodeLegacySub2APIImport(payload);
    if (decoded.providerHint && asManagedProvider(decoded.providerHint) !== decoded.providerId) {
      throw new AccountManagementError('account_management_import_provider_mismatch', 422);
    }
    const client = await this.clientFactory();
    const importResult = await client.importSub2APIAccount(decoded.document);
    const imported = importResult.account;
    assertAccountIdentity(imported, decoded.providerId);
    const account = this.emitAccountChange(imported);
    return {
      ok: true,
      imported: 1,
      status: 'succeeded',
      summary: {
        imported: 1,
        created: importResult.created ? 1 : 0,
        updated: importResult.created ? 0 : 1,
        skipped: 0,
        invalid: 0,
        failed: 0,
        total: 1,
        providers: [imported.providerId],
        accounts: [{
          provider: imported.providerId,
          accountRef: imported.accountRef,
          status: importResult.created ? 'created' : 'updated'
        }]
      },
      result: account
    };
  }

  async getImportJob(jobId: string): Promise<AccountImportJob> {
    if (!String(jobId || '').trim()) {
      throw new AccountManagementError('account_management_import_job_id_invalid', 422);
    }
    return unsupportedAccountOperation('account_management_import_job_unsupported');
  }

  // listAccountModels 仅在页面明确请求单账号模型时调用，不进入账号列表路径。
  async listAccountModels(accountRef: string): Promise<AccountModelView[]> {
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    return client.listAccountModels(accountRef);
  }

  // refreshAccountModels 等待 Go 完成一次真实刷新并直接返回持久化快照。
  async refreshAccountModels(accountRef: string): Promise<AccountModelView[]> {
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    return client.refreshAccountModels(accountRef);
  }

  // setAccountModelPolicy 只修改用户明确选择的单个账号模型策略。
  async setAccountModelPolicy(
    accountRef: string,
    modelId: string,
    manualPolicy: AccountModelView['manualPolicy']
  ): Promise<AccountModelView[]> {
    assertAccountRef(accountRef);
    const client = await this.clientFactory();
    return client.setAccountModelPolicy(accountRef, modelId, manualPolicy);
  }

  private async loadSnapshot(): Promise<AccountsListResponse> {
    const client = await this.clientFactory();
    const accountsRequest = client.listAllAccounts();
    const defaultsRequest = Promise.all(
      MANAGED_PROVIDERS.map((provider) => this.readProviderDefault(client, provider))
    );
    const [views, defaultRefs] = await Promise.all([accountsRequest, defaultsRequest]);
    this.accountViews.clear();
    for (const view of views) this.accountViews.set(view.accountRef, view);
    this.defaultAccountRefs.clear();
    for (const accountRef of defaultRefs) {
      if (accountRef) this.defaultAccountRefs.add(accountRef);
    }
    return {
      accounts: projectAccountViews(views, { defaultAccountRefs: this.defaultAccountRefs }),
      hydrating: false,
      providerNativeCapabilities: {}
    };
  }

  private async readProviderDefault(
    client: AccountManagementClient,
    provider: ManagedProvider
  ): Promise<string> {
    try {
      const relation = await client.getProviderDefault(provider);
      if (relation.providerId !== provider) {
        throw new AccountManagementError('account_management_default_response_invalid');
      }
      return relation.accountRef;
    } catch (error) {
      if (error instanceof AccountManagementError && error.status === 404) return '';
      throw error;
    }
  }

  private emitAccountChange(source: AccountView): Account {
    this.accountViews.set(source.accountRef, source);
    const account = projectAccountView(source, {
      defaultAccountRefs: this.defaultAccountRefs
    });
    this.watches.emitAccount(account);
    this.watches.notifyMutation();
    return account;
  }

  private async accountViewForMutation(
    client: AccountManagementClient,
    provider: ManagedProvider,
    accountRef: string
  ): Promise<AccountView> {
    const source = this.accountViews.get(accountRef) || await client.getAccount(accountRef);
    assertAccountIdentity(source, provider, accountRef);
    return source;
  }

  private replaceProviderDefault(provider: ManagedProvider, accountRef: string): void {
    for (const current of this.defaultAccountRefs) {
      if (this.accountViews.get(current)?.providerId === provider) {
        this.defaultAccountRefs.delete(current);
      }
    }
    this.defaultAccountRefs.add(accountRef);
  }
}

async function defaultClientFactory(): Promise<AccountManagementClient> {
  const { createActiveAccountManagementClient } = await import('./active-client.ts');
  return createActiveAccountManagementClient();
}

export type {
  AccountExportFormat,
  AccountImportPayload,
  AccountImportUploadFile,
  AccountsWatchHandlers
} from './legacy-contract.ts';

export const accountsAPI = new AccountManagementFacade();
