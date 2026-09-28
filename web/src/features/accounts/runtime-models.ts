import type { Account, AccountRuntimeModel } from '@/types';

// 模型级运行态（Go 按「账号 + 模型」冷却 / 阻塞）的展示文案。
// 一个模型 429 不代表整号不可用，所以不改账号整体状态，只在调度状态上提示「部分模型受限」。

const COOLDOWN_KIND_LABELS: Record<string, string> = {
  rate_limited: '限流冷却',
  model_overloaded: '上游繁忙冷却',
  upstream_unavailable: '上游不可用冷却',
  request_timeout: '超时冷却',
  connection_reset: '连接中断冷却',
  stream_disconnected: '流中断冷却'
};

const BLOCK_LABELS: Record<string, string> = {
  model_catalog: '不在模型目录（刷新模型目录后恢复）',
  usage_snapshot: '该模型额度耗尽（新额度快照后恢复）',
  policy_snapshot: '被上游策略拒绝（策略更新后恢复）'
};

function formatClock(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/** 仍生效的模型级条目（cooldown 已过期的丢弃，等下一次推送前也不误报）。 */
export function getActiveRuntimeModels(
  record: Pick<Account, 'runtimeModels'>,
  nowMs: number = Date.now()
): AccountRuntimeModel[] {
  return (Array.isArray(record.runtimeModels) ? record.runtimeModels : []).filter((entry) => (
    (Array.isArray(entry.blocks) && entry.blocks.length > 0)
    || Number(entry.cooldownUntil || 0) > nowMs
  ));
}

export function formatRuntimeModelLine(entry: AccountRuntimeModel, nowMs: number = Date.now()) {
  const parts: string[] = [];
  for (const block of entry.blocks || []) parts.push(BLOCK_LABELS[block] || `阻塞（${block}）`);
  const until = Number(entry.cooldownUntil || 0);
  if (until > nowMs) {
    const kind = COOLDOWN_KIND_LABELS[String(entry.cooldownKind || '')] || '冷却';
    parts.push(`${kind}至 ${formatClock(until)}`);
  }
  return `${entry.model}：${parts.join('；')}`;
}

export function getRuntimeModelLines(record: Pick<Account, 'runtimeModels'>, nowMs: number = Date.now()) {
  return getActiveRuntimeModels(record, nowMs).map((entry) => formatRuntimeModelLine(entry, nowMs));
}
