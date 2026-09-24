import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Spin } from 'antd';
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import ProviderIcon from '@/components/chat/ProviderIcon';
import {
  REQUEST_DETAIL_COLUMN_CONTRACTS,
  buildRequestTokenParts,
  formatBillingMode,
  formatReasoningEffort,
  formatRequestCost,
  formatRequestDuration,
  formatRequestType,
  formatTokens,
  type RequestDetailColumnKey
} from '@/features/model-usage/request-details-presentation';
import type { ModelUsageRequestRow } from '@/types';
import { DetailSheet, EmptySignal, HudCard, HudChips, HudIconButton, HudSection, KeyValue, MonoList, SwipeRow } from '@/mobile/ui';
import styles from '../MobileUsage.module.css';

type DetailKind = 'usage' | 'errors';

interface Props {
  usage: ModelUsageRequestRow[];
  errors: ModelUsageRequestRow[];
  requested: boolean;
  loading: boolean;
  error: string;
  limit: number;
  onRequest: () => void;
}

const formatTimestamp = (value: number, pattern: string) => (value ? dayjs(value).format(pattern) : '-');

/** 字段口径与桌面请求明细表一致（REQUEST_DETAIL_COLUMN_CONTRACTS），Token 列拆成独立行。 */
function buildDetailRows(kind: DetailKind, row: ModelUsageRequestRow) {
  const contract = REQUEST_DETAIL_COLUMN_CONTRACTS[kind];
  const rows: Array<{ key: string; label: ReactNode; value: ReactNode; mono?: boolean; tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted' }> = [];
  const push = (key: RequestDetailColumnKey, title: string) => {
    switch (key) {
      case 'model': rows.push({ key, label: title, value: row.model || '-' }); break;
      case 'reasoningEffort': rows.push({ key, label: title, value: formatReasoningEffort(row.reasoningEffort) }); break;
      case 'endpoint': rows.push({ key, label: title, value: row.endpoint || '-' }); break;
      case 'clientIp': rows.push({ key, label: title, value: row.clientIp || '-' }); break;
      case 'requestType': rows.push({ key, label: title, value: formatRequestType(row.requestType) }); break;
      case 'billingMode': rows.push({ key, label: title, value: formatBillingMode(row.billingMode) }); break;
      case 'tokens':
        buildRequestTokenParts(row).forEach((part) => {
          rows.push({ key: `tokens-${part.key}`, label: `${title} · ${part.label}`, value: formatTokens(part.value), tone: part.key === 'total' ? 'info' : undefined });
        });
        break;
      case 'costUsd': rows.push({ key, label: title, value: formatRequestCost(row.costUsd), tone: 'ok' }); break;
      case 'durationMs': rows.push({ key, label: title, value: formatRequestDuration(row.durationMs) }); break;
      case 'timestampMs': rows.push({ key, label: title, value: formatTimestamp(row.timestampMs, 'YYYY-MM-DD HH:mm:ss') }); break;
      case 'statusCode': rows.push({ key, label: title, value: row.statusCode || '-', tone: 'err' }); break;
      case 'errorMessage':
        rows.push({
          key,
          label: title,
          value: [String(row.errorMessage || '').trim() || '-', row.errorCode].filter(Boolean).join(' · '),
          mono: false,
          tone: 'err'
        });
        break;
      default: break;
    }
  };
  contract.forEach(({ key, title }) => push(key, title));
  return rows;
}

/** 请求明细：与桌面一致按需读取（modelUsageAPI.requests，最近 N 条），列表 + 点按展开完整字段。 */
export default function UsageRequestDetails({ usage, errors, requested, loading, error, limit, onRequest }: Props) {
  const [kind, setKind] = useState<DetailKind>('usage');
  const [active, setActive] = useState<{ kind: DetailKind; row: ModelUsageRequestRow } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!requested) {
    return (
      <HudSection title="请求明细" code="REQ">
        <HudCard>
          <p className={styles.prose}>成功与错误请求仅在需要时读取，避免日志解析占用趋势与分量统计的首屏资源。</p>
          <Button block icon={<ReloadOutlined />} onClick={onRequest}>加载最近 {limit} 条</Button>
        </HudCard>
      </HudSection>
    );
  }

  const rows = kind === 'usage' ? usage : errors;

  return (
    <HudSection
      title="请求明细"
      code="REQ"
      extra={<HudIconButton icon={<ReloadOutlined />} label="刷新明细" loading={loading} onClick={onRequest} />}
    >
      {error ? <p className={styles.inlineError} role="status">请求明细加载失败：{error}</p> : null}
      <HudChips
        ariaLabel="请求明细类型"
        value={kind}
        onChange={(key) => setKind(key as DetailKind)}
        items={[
          { key: 'usage', label: '用量明细', count: usage.length },
          { key: 'errors', label: '错误请求', count: errors.length }
        ]}
      />
      {loading && rows.length === 0 ? (
        <div className={styles.listLoading}><Spin /></div>
      ) : rows.length === 0 ? (
        <EmptySignal description={kind === 'usage' ? '当前范围内没有用量明细。' : '当前范围内没有错误请求。'} />
      ) : (
        <MonoList ariaLabel={kind === 'usage' ? '用量明细' : '错误请求'}>
          {rows.map((row) => (
            <SwipeRow
              key={row.requestId}
              onTap={() => {
                setActive({ kind, row });
                setSheetOpen(true);
              }}
              ariaLabel={`查看请求 ${row.model || row.requestId} 的明细`}
            >
              <span className="mhud-row__icon">
                {row.provider ? <ProviderIcon provider={row.provider} size={18} /> : <WarningOutlined />}
              </span>
              <span className="mhud-row__main">
                <span className="mhud-row__title">{row.model || '-'}</span>
                <span className={`mhud-row__meta${kind === 'errors' ? ' mhud-tone--err' : ''}`}>
                  {kind === 'usage'
                    ? `${formatRequestType(row.requestType)} · ${formatRequestDuration(row.durationMs)} · ${row.endpoint || '-'}`
                    : String(row.errorMessage || '').trim() || row.errorCode || '-'}
                </span>
              </span>
              <span className="mhud-row__side">
                {kind === 'usage' ? (
                  <>
                    <span className="mhud-tone--info">{formatTokens(row.totalTokens)}</span>
                    <span className={styles.cost}>{formatRequestCost(row.costUsd)}</span>
                  </>
                ) : (
                  <span className="mhud-status mhud-tone--err">
                    <span className="hud-led hud-led--err" />
                    {row.statusCode || 'ERR'}
                  </span>
                )}
                <span className={styles.dim}>{formatTimestamp(row.timestampMs, 'MM-DD HH:mm:ss')}</span>
              </span>
            </SwipeRow>
          ))}
        </MonoList>
      )}

      {active ? (
        <DetailSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          code={active.kind === 'usage' ? 'REQUEST' : 'REQUEST ERR'}
          title={active.row.model || active.row.requestId}
        >
          <KeyValue rows={buildDetailRows(active.kind, active.row)} />
        </DetailSheet>
      ) : null}
    </HudSection>
  );
}
