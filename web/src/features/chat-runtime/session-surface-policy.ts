import type { ChatAccount, Session } from '@/types';
import { chatRuntimeProviders } from './runtime-provider-registry';
import {
  chatAccountIdentity,
  isAihServerAccount,
  makeAihServerAccount,
  supportsAihServer,
} from '@/components/chat/aih-server-account';

export type ApprovalMode = 'bypass' | 'confirm' | 'plan';

export interface SessionRuntimeTarget {
  readonly provider: string;
  readonly executionAccountRef: string;
  readonly projectPath: string;
  readonly nativeSessionId?: string;
  readonly sessionId?: string;
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
  if (input.session.accountRef && input.session.accountRef !== input.account.accountRef) return blocked('provider_mismatch');
  if (!descriptor.acceptsAccount(input.account)) return blocked('account_required');

  return {
    status: 'ready',
    target: {
      provider: input.session.provider,
      executionAccountRef: input.account.accountRef,
      projectPath,
      ...(!input.session.draft ? { nativeSessionId: input.session.id } : {}),
      ...(input.session.runtimeSessionId ? { sessionId: input.session.runtimeSessionId } : {}),
      policy: { approvalMode: input.approvalMode },
    },
  };
}

export function runtimeAccountsForSession(
  session: Session,
  accounts: readonly ChatAccount[],
): readonly ChatAccount[] {
  if (session.mode === 'chat') {
    return withGatewayAccounts(accounts);
  }
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return [];
  return accounts.filter((account) => descriptor.acceptsAccount(account));
}

/**
 * 在真实账号后追加「aih-server(全部账号+别名)」目标：每个**有账号且支持 gatewayProfile**
 * 的 provider 一条。它代表"由网关在该 provider 池内挑号 + 别名回落"，所以与具体账号并列
 * 出现在账号菜单里（与 legacy 引擎的呈现一致）。
 */
export function withGatewayAccounts(accounts: readonly ChatAccount[]): readonly ChatAccount[] {
  const providers = [...new Set(accounts
    .map((account) => account.provider)
    .filter((provider) => supportsAihServer(provider)))];
  return [
    ...accounts,
    ...providers.map((provider) => makeAihServerAccount(provider)),
  ];
}

function resolveChatTarget(input: ResolveTargetInput): SessionRuntimeTargetResolution {
  const account = input.account;
  const boundScope = String(input.session.accountRef || '').trim();
  const gatewayTarget = isAihServerAccount(account);
  const providedIdentity = chatAccountIdentity(account);
  // 网关目标（aih-server）没有 accountRef：作用域字符串带 provider，交给网关在池内挑号。
  const accountRef = gatewayTarget ? providedIdentity : (boundScope || providedIdentity);
  if (!accountRef) return blocked('account_required');
  if (account && account.provider !== input.session.provider) return blocked('provider_mismatch');
  // 会话已绑定目标时，传入的账号/网关目标必须与它一致（否则就是拿别人的运行态顶替）。
  if (boundScope && providedIdentity && boundScope !== providedIdentity) return blocked('provider_mismatch');
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
