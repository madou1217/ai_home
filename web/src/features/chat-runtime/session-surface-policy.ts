import type { ChatAccount, Session } from '@/types';
import { chatRuntimeProviders } from './runtime-provider-registry';
import {
  chatAccountIdentity,
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

/**
 * 换账号时该做什么。三种结果：
 * - `ignore`：目标没变（含网关目标 gateway:<provider> 的稳定标识比较）。
 * - `retarget`：**同 provider** 且已有服务端会话 → 换执行凭据、会话不变（服务端 open 时 rebind，
 *   时间线保留、harness 换账号并回填历史）。
 * - `new-session`：跨 provider（协议不同）或还没有服务端会话（草稿）→ 按原行为新建。
 */
export type ChatAccountChangeAction = 'ignore' | 'retarget' | 'new-session';

export function resolveChatAccountChange(input: {
  readonly mode?: Session['mode'];
  readonly provider: Provider;
  readonly accountRef?: string;
  readonly draft?: boolean;
  readonly runtimeSessionId?: string;
  readonly account: ChatAccount;
}): ChatAccountChangeAction {
  const identity = chatAccountIdentity(input.account);
  if (String(input.accountRef || '') === identity) return 'ignore';
  if (input.mode !== 'chat') return 'new-session';
  if (input.provider !== input.account.provider) return 'new-session';
  if (input.draft || !input.runtimeSessionId) return 'new-session';
  return 'retarget';
}

function resolveChatTarget(input: ResolveTargetInput): SessionRuntimeTargetResolution {
  const account = input.account;
  const boundScope = String(input.session.accountRef || '').trim();
  const providedIdentity = chatAccountIdentity(account);
  // 显式传入的账号优先：同 provider 换账号时目标就是新账号（服务端 open 会 rebind）；
  // 没有账号时退回会话已绑定的作用域。
  const accountRef = providedIdentity || boundScope;
  if (!accountRef) return blocked('account_required');
  if (account && account.provider !== input.session.provider) return blocked('provider_mismatch');
  // 会话已绑定的目标与传入账号不同时：**同 provider 就是换执行凭据**（服务端 open 会 rebind，
  // 会话与时间线不变），跨 provider 已在上一步挡住。
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
