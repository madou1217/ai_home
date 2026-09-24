import { useEffect, useRef, useState } from 'react';
import { Button, Spin } from 'antd';
import { CopyOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import type { UsageBreakdownTarget } from '@/features/model-usage/UsageBreakdownDrawer';
import {
  formatAccountScope,
  formatCacheRate,
  formatCost,
  formatTokens,
  getCacheTokens
} from '@/features/model-usage/model-usage-presentation';
import type { Account, ModelUsageBreakdownResponse } from '@/types';
import { DetailSheet, EmptySignal, HudChips, KeyValue, MonoList, SwipeRow } from '@/mobile/ui';
import styles from '../MobileUsage.module.css';

interface Props {
  target: UsageBreakdownTarget | null;
  data: ModelUsageBreakdownResponse | null;
  loading: boolean;
  accountsByRef: Map<string, Account>;
  onClose: () => void;
  onCopySessionId: (sessionId: string) => void;
}

function shortAccountRef(accountRef: string) {
  return accountRef.length > 13 ? `${accountRef.slice(0, 9)}…${accountRef.slice(-4)}` : accountRef;
}

const providerLabel = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;

/**
 * 用量分量抽屉（点按模型 / 会话行展开）：modelUsageAPI.breakdown 的账号分量与模型分量，
 * 字段与桌面 UsageBreakdownDrawer 一致（账号范围、总 Tokens、Input、Output、Cache、缓存率、成本）。
 */
export default function UsageBreakdownSheet({ target, data, loading, accountsByRef, onClose, onCopySessionId }: Props) {
  const [tab, setTab] = useState<'accounts' | 'models'>('accounts');
  // 关闭动画期间保留最后一次内容，避免抽屉收起时闪空
  const lastRef = useRef<{ target: UsageBreakdownTarget; data: ModelUsageBreakdownResponse | null } | null>(null);
  useEffect(() => {
    if (target) lastRef.current = { target, data };
  }, [data, target]);
  useEffect(() => {
    setTab('accounts');
  }, [target]);
  const shown = target || lastRef.current?.target || null;
  const shownData = target ? data : lastRef.current?.data || null;
  if (!shown) return null;

  const summary = shownData?.summary;
  const title = shown.kind === 'model'
    ? `${providerLabel(shown.row.provider)} · ${shown.row.model || '未知模型'}`
    : shown.row.project || shown.row.sessionId;

  return (
    <DetailSheet
      open={Boolean(target)}
      onClose={onClose}
      code={shown.kind === 'model' ? 'MODEL MIX' : 'SESSION MIX'}
      title={title}
      footer={shown.kind === 'session' ? (
        <Button icon={<CopyOutlined />} onClick={() => onCopySessionId(shown.row.sessionId)}>复制会话 ID</Button>
      ) : undefined}
    >
      {shown.kind === 'session' ? (
        <div className={styles.sessionContext}>
          <span className={styles.sessionId}>{shown.row.sessionId}</span>
          {shown.row.cwd ? <span className={styles.sessionCwd}>{shown.row.cwd}</span> : null}
        </div>
      ) : null}

      {loading ? (
        <div className={styles.sheetLoading}><Spin /></div>
      ) : shownData && summary ? (
        <div className={styles.sheetStack}>
          <KeyValue
            rows={[
              { key: 'scope', label: '账号范围', value: formatAccountScope(summary.accountCount, summary.unattributedCalls) },
              { key: 'total', label: '总 Tokens', value: formatTokens(summary.totalTokens), tone: 'info' },
              { key: 'input', label: 'Input', value: formatTokens(summary.inputTokens) },
              { key: 'output', label: 'Output', value: formatTokens(summary.outputTokens) },
              { key: 'cache', label: 'Cache', value: `${formatTokens(getCacheTokens(summary))}（读 ${formatTokens(summary.cacheReadInputTokens)} · 写 ${formatTokens(summary.cacheCreationInputTokens)}）` },
              { key: 'rate', label: '缓存率', value: formatCacheRate(summary.cacheHitRate) },
              { key: 'cost', label: '成本', value: formatCost(summary.costUsd), tone: 'ok' }
            ]}
          />
          <HudChips
            ariaLabel="分量维度"
            value={tab}
            onChange={(key) => setTab(key as 'accounts' | 'models')}
            items={[
              { key: 'accounts', label: '账号分量', count: shownData.accounts.length },
              { key: 'models', label: '模型分量', count: shownData.models.length }
            ]}
          />
          {tab === 'accounts' ? (
            shownData.accounts.length > 0 ? (
              <MonoList ariaLabel="账号分量">
                {shownData.accounts.map((row) => {
                  const account = row.accountRef ? accountsByRef.get(row.accountRef) : undefined;
                  const provider = account?.provider || row.accountProvider;
                  const label = row.accountRef
                    ? account?.displayName || account?.email || `账号 ${shortAccountRef(row.accountRef)}`
                    : '未归属';
                  const modelsText = row.models.map((item) => item.model).filter(Boolean).join(' · ') || '-';
                  return (
                    <SwipeRow key={row.accountRef || '__unattributed__'}>
                      <span className="mhud-row__icon">
                        {provider ? <ProviderIcon provider={provider} size={18} /> : <QuestionCircleOutlined />}
                      </span>
                      <span className="mhud-row__main">
                        <span className="mhud-row__title">{label}</span>
                        <span className="mhud-row__meta">
                          {row.accountRef ? `${shortAccountRef(row.accountRef)} · ${modelsText}` : '缺少可审计账号证据，不做猜测'}
                        </span>
                        <span className="mhud-row__meta">
                          {row.calls} 次 · 缓存率 {formatCacheRate(row.cacheHitRate)}
                        </span>
                      </span>
                      <span className="mhud-row__side">
                        <span className="mhud-tone--info">{formatTokens(row.totalTokens)}</span>
                        <span className={styles.cost}>{formatCost(row.costUsd)}</span>
                      </span>
                    </SwipeRow>
                  );
                })}
              </MonoList>
            ) : (
              <EmptySignal description="暂无账号分量" />
            )
          ) : shownData.models.length > 0 ? (
            <MonoList ariaLabel="模型分量">
              {shownData.models.map((row) => (
                <SwipeRow key={`${row.provider}:${row.model}`}>
                  <span className="mhud-row__icon"><ProviderIcon provider={row.provider} size={18} /></span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{row.model || '-'}</span>
                    <span className="mhud-row__meta">
                      {providerLabel(row.provider)} · {row.calls} 次 · 缓存率 {formatCacheRate(row.cacheHitRate)}
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <span className="mhud-tone--info">{formatTokens(row.totalTokens)}</span>
                    <span className={styles.cost}>{formatCost(row.costUsd)}</span>
                  </span>
                </SwipeRow>
              ))}
            </MonoList>
          ) : (
            <EmptySignal description="暂无模型分量" />
          )}
        </div>
      ) : (
        <EmptySignal description="暂无分量数据" />
      )}
    </DetailSheet>
  );
}
