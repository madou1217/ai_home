import type { UpstreamErrorRule } from '@/types';
import { getProviderLabel, providerIds } from '@/providers/catalog';

export const UPSTREAM_ERROR_PROVIDER_OPTIONS = [
  { value: 'all', label: '全部 Provider' },
  ...providerIds.map(provider => ({ value: provider, label: getProviderLabel(provider) }))
];

export function upstreamErrorProviderLabel(provider: string) {
  return UPSTREAM_ERROR_PROVIDER_OPTIONS.find((item) => item.value === provider)?.label || provider || '全部 Provider';
}

export function createNewApiBalanceRule(): UpstreamErrorRule {
  return {
    name: '用户余额不足', enabled: true, statuses: [403], kind: 'billing_blocked',
    matchers: [
      { source: 'http_code', operator: 'equals', value: 403 },
      { source: 'json', path: 'error.type', operator: 'equals', value: 'new_api_error' },
      { source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }
    ]
  };
}

export function createUpstreamErrorMappingGroup() {
  return {
    name: 'New API 余额不足',
    description: '匹配 New API 的 403 insufficient_user_quota，阻止余额不足账号继续调度。',
    provider: 'all', enabled: true, rules: [createNewApiBalanceRule()]
  };
}

// 旧 field/pattern 规则支持多种错误信封，不能改写成只匹配 error.* 的 JSON 路径。
export function normalizeUpstreamErrorRulesForForm(value: UpstreamErrorRule[] | undefined): UpstreamErrorRule[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}
