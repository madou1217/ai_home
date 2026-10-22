import type { ChatAccount, GatewayAccount, Provider } from '@/types';
import { providerIdsByCapability } from '@/providers/catalog';

// 网关目标不是账号，不分配伪 accountRef；后端只通过 gateway=true 进入池化路由。
export const AIH_SERVER_ACCOUNT_LABEL = 'aih-server(全部账号+别名)';

// 网关 profile 的 Provider 集合来自生成合同，与后端 self-relay-account 保持同一真相源。
// 能力名必须用合同里的原字符串（snake_case）——曾写成 camelCase 'gatewayProfile'，
// 查出来恒为空集，于是 aih-server 目标在所有引擎里都从未出现过。
export const AIH_SERVER_PROVIDERS: Provider[] = providerIdsByCapability('gateway_profile') as Provider[];

export function supportsAihServer(provider?: string | null): boolean {
  return AIH_SERVER_PROVIDERS.includes(String(provider || '').trim() as Provider);
}

/**
 * 网关目标的选中标识 —— **全局唯一**，不带 provider 后缀。
 *
 * 2026-10-21 收敛：此前是 `gateway:<provider>`，每个 provider 一条，本机 15 个 provider
 * 就是 15 条同名条目；而服务端 `resolveSessionRuntimeTarget` 的 provider 守卫又让其它
 * provider 的条目在会话内选不了 —— 既是视觉噪音又误导。
 *
 * 服务端语义本来就是全局的：网关作用域的模型目录取自**全局池**（见
 * chat-harness-model-reader 的 isGatewayRuntimeScope 分支），harness 请求也不写
 * X-Provider 钉选头（见 chat-harness-gateway 的 runtimeConfigRevision v6）。所以
 * 「一条、跨 provider 通用」才是它本来的含义。
 *
 * 会话自身的 provider 仍然保留（harness 目录命名、模型元数据解析要用），只是**不再
 * 参与网关目标的标识**。
 */
export const GATEWAY_SELECTION_SCOPE = 'gateway';

/** 兼容旧的 `gateway:<provider>` 存量会话；新的统一写裸 `gateway`。 */
const GATEWAY_SELECTION_SCOPE_PATTERN = /^gateway(?::[a-z0-9][a-z0-9-]*)?$/i;

/** 该标识是不是网关目标（裸 `gateway` 与旧 `gateway:<provider>` 都算）。 */
export function isGatewaySelectionScope(value?: string | null): boolean {
  return GATEWAY_SELECTION_SCOPE_PATTERN.test(String(value || '').trim());
}

/**
 * 从选中标识取回它携带的 provider（仅旧格式有）；裸 `gateway` 返回 null。
 *
 * 用途：把存量会话 `gateway:opencode` 的 provider 回填给 harness，避免旧会话因为
 * 「不知道自己是哪个 provider」而丢掉 harness 目录命名。
 */
export function providerFromGatewayScope(value?: string | null): Provider | null {
  const text = String(value || '').trim();
  if (!text.startsWith(`${GATEWAY_SELECTION_SCOPE}:`)) return null;
  const provider = text.slice(GATEWAY_SELECTION_SCOPE.length + 1) as Provider;
  return supportsAihServer(provider) ? provider : null;
}

export function isAihServerAccount(account?: Pick<ChatAccount, 'gateway'> | null): account is GatewayAccount {
  return account?.gateway === true;
}

/** 运行作用域标记：会话列里存的值（`gateway` 或旧的 `gateway:<provider>`）。 */
export const GATEWAY_RUNTIME_SCOPE = GATEWAY_SELECTION_SCOPE;

export function isGatewayRuntimeScope(value?: string | null): boolean {
  return isGatewaySelectionScope(value);
}

/**
 * 账号选择器的稳定标识：真实账号用 accountRef，网关目标一律用裸 `gateway`。
 * 会话的 executionAccountRef 与账号菜单的 option id 必须用同一个字符串，
 * 否则 aih-server 的选中态匹配不上。
 */
export function chatAccountIdentity(account?: ChatAccount | null): string {
  if (!account) return '';
  return isAihServerAccount(account)
    ? GATEWAY_SELECTION_SCOPE
    : String(account.accountRef || '').trim();
}

/**
 * @param provider 会话/上下文的 provider。它**不影响标识**（全局唯一），只写在目标对象上，
 *   供 harness 目录命名与模型元数据解析使用。
 */
export function makeAihServerAccount(provider: Provider): GatewayAccount {
  return {
    provider,
    gateway: true,
    status: 'up',
    displayName: AIH_SERVER_ACCOUNT_LABEL,
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 0,
    planType: '',
    email: ''
  };
}
