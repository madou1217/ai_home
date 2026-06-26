import { memo, useMemo } from 'react';
import { AimOutlined } from '@ant-design/icons';
import EventBlock, { type StatusTone } from './EventBlock';
import evt from './EventBlock.module.css';

const GOAL_STATUS_TONE: Record<string, StatusTone> = {
  active: 'running',
  complete: 'success',
  blocked: 'attention',
  failed: 'failed',
  cancelled: 'cancelled'
};

interface GoalShape {
  objective?: string;
  status?: string;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  threadId?: string;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface Props {
  body?: string;
  result?: string;
  context?: string;
}

function parseJsonObject(text?: string) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function decodeGoalXmlEntities(value: string) {
  let current = String(value || '');
  for (let index = 0; index < 3; index += 1) {
    const next = current
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === current) break;
    current = next;
  }
  return current;
}

function parseXmlTagValue(source: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`);
  const match = String(source || '').match(pattern);
  return match ? decodeGoalXmlEntities(match[1].trim()) : '';
}

function stripNestedMemoryCitations(value: string) {
  return String(value || '')
    .replace(/<oai-mem-citation(?:\s+[^>]*)?>[\s\S]*?<\/oai-mem-citation>/gi, '')
    .trim();
}

function parseOptionalNumber(value?: string | number | null) {
  if (value == null || value === '') return null;
  const numericValue = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(numericValue) ? numericValue : null;
}

// 新旧 Codex 目标上下文同时存在 XML 字段和纯文本 Budget 行，这里统一成数字字段。
function parseBudgetLineValue(context: string, label: string) {
  const pattern = new RegExp(`${label}:\\s*([^\\n]+)`, 'i');
  const match = String(context || '').match(pattern);
  return match?.[1]?.trim() || '';
}

function normalizeGoalStatusKey(status?: string) {
  const value = String(status || 'active').trim().toLowerCase();
  if (value === 'complete' || value === 'completed' || value === 'done' || value === 'success') return 'complete';
  if (value === 'blocked') return 'blocked';
  if (value === 'failed' || value === 'failure' || value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled' || value === 'aborted') return 'cancelled';
  return 'active';
}

function getGoalStatusLabel(status?: string) {
  const key = normalizeGoalStatusKey(status);
  if (key === 'complete') return '已完成';
  if (key === 'blocked') return '已阻塞';
  if (key === 'failed') return '失败';
  if (key === 'cancelled') return '已取消';
  return '进行中';
}

function formatDuration(seconds?: number | null) {
  const totalSeconds = Number(seconds || 0);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const remain = Math.round(totalSeconds % 60);
  if (minutes <= 0) return `${remain} 秒`;
  if (remain <= 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${remain} 秒`;
}

function pickGoalFromTool(body?: string, result?: string): GoalShape {
  const parsedResult = parseJsonObject(result);
  const resultGoal = (parsedResult as any)?.goal || (parsedResult as any)?.result?.goal;
  if (resultGoal && typeof resultGoal === 'object') return normalizeGoalShape(resultGoal);

  const parsedBody = parseJsonObject(body);
  if ((parsedBody as any)?.objective || (parsedBody as any)?.status) return normalizeGoalShape(parsedBody);
  return {};
}

function normalizeGoalShape(input: any): GoalShape {
  if (!input || typeof input !== 'object') return {};
  return {
    objective: input.objective == null ? undefined : String(input.objective),
    status: input.status == null ? undefined : String(input.status),
    tokenBudget: parseOptionalNumber(input.tokenBudget ?? input.token_budget),
    tokensUsed: parseOptionalNumber(input.tokensUsed ?? input.tokens_used),
    timeUsedSeconds: parseOptionalNumber(input.timeUsedSeconds ?? input.time_used_seconds),
    threadId: input.threadId == null && input.thread_id == null ? undefined : String(input.threadId ?? input.thread_id),
    createdAt: parseOptionalNumber(input.createdAt ?? input.created_at),
    updatedAt: parseOptionalNumber(input.updatedAt ?? input.updated_at)
  };
}

function pickGoalFromContext(context?: string): GoalShape {
  if (!context) return {};
  const tokensUsed = parseOptionalNumber(parseXmlTagValue(context, 'tokens_used') || parseBudgetLineValue(context, 'Tokens used'));
  const rawBudget = parseXmlTagValue(context, 'token_budget') || parseBudgetLineValue(context, 'Token budget');
  return {
    objective: stripNestedMemoryCitations(parseXmlTagValue(context, 'objective')),
    status: parseXmlTagValue(context, 'status') || 'active',
    tokenBudget: rawBudget && rawBudget !== 'none' ? parseOptionalNumber(rawBudget) : null,
    tokensUsed,
    timeUsedSeconds: parseOptionalNumber(parseXmlTagValue(context, 'time_used_seconds')),
    threadId: parseXmlTagValue(context, 'thread_id')
  };
}

function formatNumber(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value.toLocaleString('en-US');
}

function GoalBlock({ body = '', result = '', context = '' }: Props) {
  const goal = useMemo(() => {
    const contextGoal = pickGoalFromContext(context);
    const toolGoal = pickGoalFromTool(body, result);
    return { ...contextGoal, ...toolGoal };
  }, [body, context, result]);

  if (!goal.objective && !goal.status) return null;

  const duration = formatDuration(goal.timeUsedSeconds);
  const statusKey = normalizeGoalStatusKey(goal.status);
  const budgetRatio = goal.tokenBudget && goal.tokensUsed
    ? Math.max(0, Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)))
    : 0;

  const hasMeta = typeof goal.tokensUsed === 'number' || typeof goal.tokenBudget === 'number' || Boolean(duration);

  return (
    <EventBlock
      tone="goal"
      icon={<AimOutlined />}
      title="目标"
      collapsible={false}
      status={{ label: getGoalStatusLabel(goal.status), tone: GOAL_STATUS_TONE[statusKey] || 'neutral', dot: statusKey === 'active' }}
      meta={goal.threadId ? <span className={evt.metaText}>{goal.threadId}</span> : null}
      aria-label="目标"
    >
      {goal.objective ? <div className={evt.prose} style={{ marginBottom: 'var(--space-6)' }}>{goal.objective}</div> : null}
      {budgetRatio > 0 ? (
        <div className={evt.progressTrack} aria-hidden="true">
          <span className={evt.progressBar} style={{ width: `${budgetRatio}%` }} />
        </div>
      ) : null}
      {hasMeta ? (
        <div className={evt.chips}>
          {typeof goal.tokensUsed === 'number' ? <span className={evt.metaText}>{`已用 ${formatNumber(goal.tokensUsed)} Token`}</span> : null}
          {typeof goal.tokenBudget === 'number' ? <span className={evt.metaText}>{`预算 ${formatNumber(goal.tokenBudget)} Token`}</span> : null}
          {duration ? <span className={evt.metaText}>{`用时 ${duration}`}</span> : null}
        </div>
      ) : null}
    </EventBlock>
  );
}

export default memo(GoalBlock);
