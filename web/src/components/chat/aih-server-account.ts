import type { ChatAccount, GatewayAccount, Provider } from '@/types';

// 网关目标不是账号，不分配伪 accountRef；后端只通过 gateway=true 进入池化路由。
export const AIH_SERVER_ACCOUNT_LABEL = 'aih-server(全部账号+别名)';
const GATEWAY_SELECTION_SCOPE_PREFIX = 'gateway:';

// 仅这些 provider 支持网关 profile（与后端 self-relay-account.AIH_SERVER_PROFILE_PROVIDERS 对齐）。
// agy 无端点覆盖、gemini 尚未接入网关 → 不提供该选项，保持单账号直连。
export const AIH_SERVER_PROVIDERS: Provider[] = ['codex', 'claude', 'opencode', 'grok', 'kimi', 'kiro'];

export function supportsAihServer(provider?: string | null): boolean {
  return AIH_SERVER_PROVIDERS.includes(String(provider || '').trim() as Provider);
}

export function getGatewaySelectionScope(provider: Provider): string {
  return `${GATEWAY_SELECTION_SCOPE_PREFIX}${provider}`;
}

export function parseGatewaySelectionScope(value: string): Provider | null {
  if (!value.startsWith(GATEWAY_SELECTION_SCOPE_PREFIX)) return null;
  const provider = value.slice(GATEWAY_SELECTION_SCOPE_PREFIX.length) as Provider;
  return supportsAihServer(provider) ? provider : null;
}

export function isAihServerAccount(account?: Pick<ChatAccount, 'gateway'> | null): account is GatewayAccount {
  return account?.gateway === true;
}

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
