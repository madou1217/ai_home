import type {
  AccountAddJob,
  AccountRefreshJob,
  AddAccountRequest,
  AddAccountResponse
} from '../../types/index.ts';
import { assertManagedProvider } from './decoders.ts';
import { AccountManagementError, unsupportedAccountOperation } from './errors.ts';
import type {
  AccountUsageView,
  AccountView,
  ManagedProvider,
  OAuthJobStartView,
  OAuthJobView,
  StaticCredentialInput
} from './types.ts';

export function asManagedProvider(value: unknown): ManagedProvider {
  assertManagedProvider(value);
  return value;
}

export function assertAccountIdentity(
  source: AccountView,
  provider: ManagedProvider,
  accountRef?: string
): void {
  if (source.providerId !== provider || (accountRef && source.accountRef !== accountRef)) {
    throw new AccountManagementError('account_management_account_identity_mismatch');
  }
}

export function staticCredentialFromLegacy(
  provider: ManagedProvider,
  payload: AddAccountRequest
): StaticCredentialInput {
  const config = payload.config || {};
  if (config.credentialType && config.credentialType !== payload.authMode) {
    throw new AccountManagementError('account_management_credential_kind_mismatch', 422);
  }
  if (payload.authMode === 'api-key') {
    return {
      kind: 'api_key',
      apiKey: String(config.apiKey || ''),
      ...(config.baseUrl ? { baseUrl: String(config.baseUrl) } : {})
    };
  }
  if (payload.authMode === 'auth-token' && provider === 'claude') {
    return {
      kind: 'auth_token',
      authToken: String(config.apiKey || ''),
      ...(config.baseUrl ? { baseUrl: String(config.baseUrl) } : {})
    };
  }
  return unsupportedAccountOperation('account_management_static_auth_mode_unsupported');
}

export function replacementCredentialFromLegacy(
  provider: ManagedProvider,
  data: { apiKey?: string; baseUrl?: string; authMode?: string; credentialType?: string }
): StaticCredentialInput {
  const authMode = String(data.credentialType || data.authMode || 'api-key');
  if (data.credentialType && data.authMode && data.credentialType !== data.authMode) {
    throw new AccountManagementError('account_management_credential_kind_mismatch', 422);
  }
  const apiKey = String(data.apiKey || '');
  if (!apiKey) throw new AccountManagementError('account_management_credential_required', 422);
  if (authMode === 'api-key') {
    return {
      kind: 'api_key',
      apiKey,
      ...(data.baseUrl ? { baseUrl: String(data.baseUrl) } : {})
    };
  }
  if (authMode === 'auth-token' && provider === 'claude') {
    return {
      kind: 'auth_token',
      authToken: apiKey,
      ...(data.baseUrl ? { baseUrl: String(data.baseUrl) } : {})
    };
  }
  return unsupportedAccountOperation('account_management_static_auth_mode_unsupported');
}

export function projectOAuthStart(source: OAuthJobStartView): AddAccountResponse {
  return {
    ok: true,
    provider: source.providerId,
    accountRef: source.targetAccountRef || source.accountRef || '',
    authMode: 'oauth-browser',
    status: source.status === 'completed' ? 'configured' : 'pending',
    jobId: source.jobId,
    expiresAt: Date.parse(source.expiresAt),
    authorizationUrl: source.authorizationUrl,
    authProgressState: oauthProgressState(source),
    setupPhase: 'oauth',
    installRequired: false
  };
}

export function projectOAuthJob(
  source: OAuthJobView,
  cachedAuthorizationUrl?: string
): AccountAddJob {
  const finishedAt = source.finishedAt ? Date.parse(source.finishedAt) : null;
  const status = oauthLegacyStatus(source.status);
  const authorizationUrl = cachedAuthorizationUrl || ('authorizationUrl' in source
    && typeof source.authorizationUrl === 'string'
    ? source.authorizationUrl
    : undefined);
  return {
    id: source.jobId,
    provider: source.providerId,
    accountRef: source.accountRef || source.targetAccountRef || '',
    authMode: 'oauth-browser',
    status,
    createdAt: Date.parse(source.createdAt),
    updatedAt: finishedAt || Date.parse(source.createdAt),
    expiresAt: Date.parse(source.expiresAt),
    exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : null,
    authorizationUrl,
    authProgressState: oauthProgressState(source),
    setupPhase: 'oauth',
    installRequired: false,
    logs: '',
    ...(status === 'failed' ? { error: 'OAuth 授权失败' } : {})
  };
}

export function projectUsageRefreshJob(source: AccountUsageView): AccountRefreshJob {
  const capturedAt = Date.parse(source.capturedAt);
  return {
    id: `usage-${source.accountRef}-${capturedAt}`,
    provider: source.providerId,
    accountRef: source.accountRef,
    status: 'succeeded',
    createdAt: capturedAt,
    updatedAt: capturedAt,
    finishedAt: capturedAt
  };
}

function oauthLegacyStatus(status: OAuthJobView['status']): AccountAddJob['status'] {
  if (status === 'pending' || status === 'processing') return 'running';
  if (status === 'completed') return 'succeeded';
  return status;
}

function oauthProgressState(source: OAuthJobView): string {
  if (source.status === 'pending') return 'awaiting_code';
  if (source.status === 'processing') return 'processing';
  if (source.status === 'completed') return 'completed';
  return source.status;
}
