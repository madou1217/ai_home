import type { UpstreamErrorRule } from '@/types';
import { getProviderLabel, providerIds } from '@/providers/catalog';

export const UPSTREAM_ERROR_PROVIDER_OPTIONS = [
  { value: 'all', label: '全部 Provider' },
  ...providerIds.map(provider => ({ value: provider, label: getProviderLabel(provider) }))
];

export function upstreamErrorProviderLabel(provider: string) {
  return UPSTREAM_ERROR_PROVIDER_OPTIONS.find((item) => item.value === provider)?.label || provider || '全部 Provider';
}

// createNewApiBalanceRule 只认 New API 的稳定错误码，不认 error.type。
//
// New API（one-api 系）对「用户额度不足」固定回 403 + error.code =
// insufficient_user_quota，但 error.type 是各部署自己改写的：官方/ooioo 用
// new_api_error，4router 用 4router_error。把 type 也写成 AND 条件会让规则对
// 所有改了 type 的中转永远不命中——欠费账号因此识别不出，被内建启发式误判成
// 凭据失效（403 → auth_invalid）。故只按 code 判别，兼容全部 New API 部署。
export function createNewApiBalanceRule(): UpstreamErrorRule {
  return {
    name: '用户余额不足', enabled: true, statuses: [403], kind: 'billing_blocked',
    matchers: [
      { source: 'http_code', operator: 'equals', value: 403 },
      { source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }
    ]
  };
}

// createOneApiBalanceRule 覆盖 one-api 系（jiji）的信封：余额不足是顶层 code，
// 没有 error 包裹（实测 jiji 403 `{"code":"INSUFFICIENT_BALANCE",...}`）。与
// New API 规则的 JSON 路径不同、互不重叠，两条规则顺序无关。
export function createOneApiBalanceRule(): UpstreamErrorRule {
  return {
    name: '余额不足（one-api）', enabled: true, statuses: [403], kind: 'billing_blocked',
    matchers: [
      { source: 'http_code', operator: 'equals', value: 403 },
      { source: 'json', path: 'code', operator: 'equals', value: 'INSUFFICIENT_BALANCE' }
    ]
  };
}

export function createUpstreamErrorMappingGroup() {
  return {
    name: 'New API 余额不足',
    description: '按 New API / one-api 结构化错误码识别余额不足，阻止余额不足账号继续调度。',
    provider: 'all', enabled: true, rules: [createNewApiBalanceRule(), createOneApiBalanceRule()]
  };
}

// 旧 field/pattern 规则支持多种错误信封，不能改写成只匹配 error.* 的 JSON 路径。
export function normalizeUpstreamErrorRulesForForm(value: UpstreamErrorRule[] | undefined): UpstreamErrorRule[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}
