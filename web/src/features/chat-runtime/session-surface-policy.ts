import type { ChatAccount, Provider, Session } from '@/types';
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
    return withGatewayAccounts(accounts, session.provider);
  }
  const descriptor = chatRuntimeProviders.resolve(session.provider);
  if (!descriptor) return [];
  return accounts.filter((account) => descriptor.acceptsAccount(account));
}

/**
 * 在真实账号后追加「aih-server(全部账号+别名)」目标 —— **全局唯一一条，跨 provider 通用**。
 *
 * 它代表「不钉账号、也不钉 provider，由网关按模型 id 挑号」；选中后模型列表就是整个
 * server 的目录（服务端对网关作用域返回全局池，见 chat-harness-model-reader 的
 * isGatewayRuntimeScope 分支），harness 请求也不写 X-Provider 钉选头
 * （见 chat-harness-gateway 的 runtimeConfigRevision v6）。所以它本来就与 provider 无关。
 *
 * 2026-10-21 收敛：此前每个 provider 一条（`gateway:<provider>`），本机 15 个 provider
 * 就是 15 条同名条目 —— 既是视觉噪音，也让人误以为要按 provider 选。
 *
 * 何时追加：只要**任一**账号声明 `gatewayTargetSupported`（描述符 relay 能力：
 * transport=http 且不依赖本机客户端），或该 provider 有 `gateway_profile` 能力，就有
 * 可用的池。判定来自服务端结论，前端不维护 provider 清单。
 *
 * @param provider 会话自己的 provider —— 只用来判断「有没有可绑的池」，不进标识。
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
 * - `ignore`：目标没变（网关目标按裸 `gateway` 比较，与 provider 无关）。
 * - `retarget`：**同 provider** 且已有服务端会话 → 换执行凭据、会话不变（服务端 open 时 rebind，
 *   时间线保留、harness 换账号并回填历史）。
 * - `new-session`：跨 provider（协议不同）或还没有服务端会话（草��）→ 按原行为新建。
 *
 * 注意：选网关目标**不是**跨 provider —— 会话 provider 不变，只是不钉账号。所以它命中
 * retarget（有服务端会话时）而不是 new-session。
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
  // 网关目标不携带 provider 语义（全局池），不算跨 provider。
  if (!isAihServerAccount(input.account) && input.provider !== input.account.provider) return 'new-session';
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
  // 网关目标是全局池，跨 provider 通用 —— 会话 provider 保持原值（harness 目录命名与
  // 模型元数据解析仍要用它），不触发 provider_mismatch。
  if (account && !isAihServerAccount(account) && account.provider !== input.session.provider) {
    return blocked('provider_mismatch');
  }
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
