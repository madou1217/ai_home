export const REQUEST_DETAIL_COLUMN_CONTRACTS = Object.freeze({
  usage: Object.freeze([
    { key: 'provider', title: 'Provider' },
    { key: 'model', title: '模型' },
    { key: 'reasoningEffort', title: '推理强度' },
    { key: 'endpoint', title: '端点' },
    { key: 'clientIp', title: 'IP' },
    { key: 'requestType', title: '类型' },
    { key: 'billingMode', title: '计费模式' },
    { key: 'tokens', title: 'Token' },
    { key: 'costUsd', title: '费用' },
    { key: 'durationMs', title: '延迟' },
    { key: 'timestampMs', title: '时间' }
  ] as const),
  errors: Object.freeze([
    { key: 'provider', title: 'Provider' },
    { key: 'model', title: '模型' },
    { key: 'reasoningEffort', title: '推理强度' },
    { key: 'endpoint', title: '端点' },
    { key: 'clientIp', title: 'IP' },
    { key: 'requestType', title: '类型' },
    { key: 'statusCode', title: '状态码' },
    { key: 'errorMessage', title: '错误信息' },
    { key: 'durationMs', title: '延迟' },
    { key: 'timestampMs', title: '时间' }
  ] as const)
});

export type RequestDetailColumnKey =
  typeof REQUEST_DETAIL_COLUMN_CONTRACTS.usage[number]['key']
  | typeof REQUEST_DETAIL_COLUMN_CONTRACTS.errors[number]['key'];

export interface RequestTokenInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface RequestTokenPart {
  key: 'input' | 'output' | 'cache' | 'reasoning' | 'total';
  label: string;
  value: number;
}

export function formatTokens(value: number) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

export function formatRequestDuration(value: number) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds <= 0) return '-';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = (milliseconds / 1000).toFixed(2).replace(/\.?0+$/u, '');
  return `${seconds} s`;
}

export function formatRequestCost(value: number) {
  return `$${Math.max(0, Number(value) || 0).toFixed(6)}`;
}

export function formatRequestProvider(value: string) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'gateway') return 'AIH 网关';
  return provider || '历史未记录';
}

export function formatReasoningEffort(value: string) {
  const effort = String(value || '').trim();
  if (!effort) return '历史未记录';
  if (effort === 'provider_default') return 'Provider 默认';
  if (effort === 'not_applicable') return '不适用';
  const budgetMatch = effort.match(/^budget:(-?\d+)$/u);
  if (budgetMatch) {
    const budget = Number(budgetMatch[1]);
    if (budget === -1) return '自动预算';
    if (budget === 0) return '关闭';
    return `预算 ${budget.toLocaleString('en-US')} Tokens`;
  }
  const labels: Record<string, string> = {
    adaptive: '自适应',
    disabled: '已关闭',
    enabled: '已启用',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh'
  };
  return labels[effort.toLowerCase()] || effort;
}

export function formatRequestType(value: string) {
  const requestType = String(value || '').trim().toLowerCase();
  if (requestType === 'stream') return '流式';
  if (requestType === 'sync') return '同步';
  return '历史未记录';
}

export function formatBillingMode(value: string) {
  const billingMode = String(value || '').trim().toLowerCase();
  if (billingMode === 'token') return '按 Token';
  return billingMode || '-';
}

export function buildRequestTokenParts(input: RequestTokenInput): RequestTokenPart[] {
  const cacheTokens = (Number(input.cacheReadInputTokens) || 0)
    + (Number(input.cacheCreationInputTokens) || 0);
  const parts: RequestTokenPart[] = [
    { key: 'input', label: '输入', value: Number(input.inputTokens) || 0 },
    { key: 'output', label: '输出', value: Number(input.outputTokens) || 0 }
  ];
  if (cacheTokens > 0) parts.push({ key: 'cache', label: '缓存', value: cacheTokens });
  const reasoningTokens = Number(input.reasoningOutputTokens) || 0;
  if (reasoningTokens > 0) parts.push({ key: 'reasoning', label: '推理', value: reasoningTokens });
  parts.push({ key: 'total', label: '总计', value: Number(input.totalTokens) || 0 });
  return parts;
}
