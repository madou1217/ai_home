import type { Account, ChatAccount, Session } from '@/types';
import { chatRuntimeProviders } from './runtime-provider-registry';

export type ApprovalMode = 'bypass' | 'confirm' | 'plan';

export interface SessionRuntimeTarget {
  readonly provider: string;
  readonly executionAccountRef: string;
  readonly projectPath: string;
  readonly nativeSessionId?: string;
  readonly policy: Readonly<{ approvalMode: ApprovalMode }>;
}

export type SessionRuntimeTargetResolution =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly target: SessionRuntimeTarget }
  | { readonly status: 'blocked'; readonly reason: RuntimeTargetBlockReason };

export type RuntimeTargetBlockReason =
  | 'account_required'
  | 'provider_mismatch'
  | 'project_path_required'
  | 'runtime_provider_unsupported';

interface ResolveTargetInput {
  readonly session: Session;
  readonly account: ChatAccount | null;
  readonly projectPath?: string;
  readonly approvalMode: ApprovalMode;
}

export function usesCanonicalSessionRuntime(session: Session | null): boolean {
  return Boolean(session && chatRuntimeProviders.resolve(session.provider));
}

export function resolveSessionRuntimeTarget(
  input: ResolveTargetInput,
): SessionRuntimeTargetResolution {
  const projectPath = String(input.projectPath || input.session.projectPath || '').trim();
  const descriptor = chatRuntimeProviders.resolve(input.session.provider);
  if (!descriptor) return blocked('runtime_provider_unsupported');
  if (!projectPath) return blocked('project_path_required');
  if (!input.account) return blocked('account_required');
  if (input.account.provider !== input.session.provider) return blocked('provider_mismatch');
  if (!descriptor.acceptsAccount(input.account)) return blocked('account_required');

  return {
    status: 'ready',
    target: {
      provider: input.session.provider,
      executionAccountRef: input.account.accountRef,
      projectPath,
      ...(!input.session.draft ? { nativeSessionId: input.session.id } : {}),
      policy: { approvalMode: input.approvalMode },
    },
  };
}

export function runtimeAccountsForSession(
  session: Session,
  accounts: readonly Account[],
): readonly Account[] {
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return [];
  return accounts.filter((account) => descriptor.acceptsAccount(account));
}

function blocked(reason: RuntimeTargetBlockReason): SessionRuntimeTargetResolution {
  return { status: 'blocked', reason };
}
