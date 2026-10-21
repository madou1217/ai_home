import type { ChatAccount, Provider, Session } from '@/types';
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
    return withGatewayAccounts(accounts, session.provider);
  }
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return [];
  return accounts.filter((account) => descriptor.acceptsAccount(account));
}

/**
 * 在真实账号后追加「aih-server(全部账号+别名)」目标 —— **每个会话只一条**。
 *
 * 它代表「不钉账号，由网关挑号」；选中后模型列表就是整个 server 的目录（服务端对网关
 * 作用域返回全局池，见 chat-harness-model-reader）。
 *
 * 为什么只给**会话自己的 provider** 一条（2026-10-21 真机反馈「账号里 aih-server 出现了
 * 15 次」）：服务端 `resolveSessionRuntimeTarget` 有 provider_mismatch 守卫 —— 账号
 * provider 必须等于会话 provider。所以其它 provider 的网关条目在会话内**根本选不了**，
 * 列出来既是视觉噪音，也让人误以为能跨 provider 换（实际会 blocked）。同理，网关作用域
 * 的 harness 也按 `gateway-<provider>` 分目录，多列无用。
 *
 * 判定两个来源并集（都来自服务端结论，前端不维护 provider 清单）：
 * - 生成合同的 `gateway_profile` 能力（CLI 可被指向网关的那批）；
 * - 账号 payload 的 `gatewayTargetSupported`（描述符 relay 能力：transport=http 且
 *   不依赖本机客户端）。后者让 agy 这类「CLI 不能指向网关、但网关能直接服务」的
 *   provider 也拿到 aih-server 目标 —— chat 模式因此不需要启 CLI。
 *
 * @param provider 会话自己的 provider；缺省时不追加任何网关目标（没有可绑的池）。
 */
export function withGatewayAccounts(
  accounts: readonly ChatAccount[],
  provider?: Provider | null,
): readonly ChatAccount[] {
  const target = String(provider || '').trim();
  if (!target) return accounts;
  const gatewayCapable = accounts.some(
    (account) => account.provider === target && account.gatewayTargetSupported === true,
  );
  if (!gatewayCapable && !supportsAihServer(target)) return accounts;
  return [...accounts, makeAihServerAccount(target as Provider)];
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
