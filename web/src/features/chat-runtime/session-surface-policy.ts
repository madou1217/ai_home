import type { Account, ChatAccount, Session } from '@/types';
import { chatRuntimeProviders } from './runtime-provider-registry';

export type ApprovalMode = 'bypass' | 'confirm' | 'plan';

export interface SessionRuntimeTarget {
  readonly provider: string;
  readonly executionAccountRef: string;
  readonly projectPath: string;
  readonly nativeSessionId?: string;
  readonly chatSessionId?: string;
  readonly policy: Readonly<{ approvalMode: ApprovalMode; workspaceMode?: 'chat' }>;
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

export function usesCanonicalSessionRuntime(
  session: Session | null,
  account?: ChatAccount | null,
): boolean {
  if (!session) return false;
  if (session.mode === 'chat') return true;
  if (!session.projectPath) return false;
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return false;
  return account === undefined || Boolean(account && descriptor.acceptsAccount(account));
}

export function resolveSessionRuntimeTarget(
  input: ResolveTargetInput,
): SessionRuntimeTargetResolution {
  if (input.session.mode === 'chat') return resolveChatTarget(input);
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
  if (session.mode === 'chat') {
    return accounts.filter((account) => session.draft || !session.accountRef || account.accountRef === session.accountRef);
  }
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return [];
  return accounts.filter((account) => descriptor.acceptsAccount(account));
}

function resolveChatTarget(input: ResolveTargetInput): SessionRuntimeTargetResolution {
  const account = input.account;
  const accountRef = input.session.accountRef || account?.accountRef;
  if (!accountRef) return blocked('account_required');
  if (account && (account.provider !== input.session.provider
    || (input.session.accountRef && input.session.accountRef !== account.accountRef))) {
    return blocked('provider_mismatch');
  }
  return {
    status: 'ready',
    target: {
      provider: input.session.provider,
      executionAccountRef: accountRef,
      projectPath: '',
      ...(input.session.runtimeSessionId || !input.session.draft
        ? { chatSessionId: input.session.runtimeSessionId || input.session.id } : {}),
      policy: { workspaceMode: 'chat', approvalMode: 'confirm' },
    },
  };
}

function blocked(reason: RuntimeTargetBlockReason): SessionRuntimeTargetResolution {
  return { status: 'blocked', reason };
}
