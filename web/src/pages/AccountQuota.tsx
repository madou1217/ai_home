import { useEffect, useMemo, useState } from 'react';
import { Alert, Grid, Segmented, Select, Space, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';

// 与模型用量页共用同一套 HUD 表面（KPI 切角条、发丝网格、图表壳）；
// 改动 .usage-* 时两边要一起看，避免视觉语言分叉。
import '@/pages/ModelUsage.css';
import './AccountQuota.css';

import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import Button from '@/components/ui/AppButton';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import QuotaWindowChart from '@/features/quota-stats/QuotaWindowChart';
import QuotaWindowTable from '@/features/quota-stats/QuotaWindowTable';
import { useQuotaStats } from '@/features/quota-stats/use-quota-stats';
import {
  QUOTA_DIMENSION_OPTIONS,
  QUOTA_RANGE_OPTIONS,
  formatQuotaClock,
  formatQuotaPct
} from '@/features/quota-stats/quota-stats-model';

function shortenAccountRef(accountRef: string) {
  if (accountRef.length <= 18) return accountRef;
  return `${accountRef.slice(0, 9)}…${accountRef.slice(-6)}`;
}

export default function AccountQuota() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const navigate = useNavigate();
  const routeParams = useParams<{ provider?: string; accountRef?: string }>();
  const provider = String(routeParams.provider || '').trim().toLowerCase();
  const accountRef = String(routeParams.accountRef || '').trim();

  const [windowMinutes, setWindowMinutes] = useState(300);
  const [rangeDays, setRangeDays] = useState(30);
  const [scopeKey, setScopeKey] = useState('');

  const { data, loading, error, reload } = useQuotaStats({
    provider,
    accountRef,
    windowMinutes,
    scopeKey,
    rangeDays
  });

  // 首屏可能落在「这个账号没有 5h 窗口」上：自动切到第一个可用维度。
  // 不可用项在 Segmented 里是 disabled，所以用户不会主动切进死胡同。
  useEffect(() => {
    if (!data) return;
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === windowMinutes);
    if (selected?.available) return;
    const fallback = data.dimensions.find((dimension) => dimension.available);
    if (fallback && fallback.windowMinutes !== windowMinutes) {
      setWindowMinutes(fallback.windowMinutes);
    }
  }, [data, windowMinutes]);

  // 服务端可能因为 scope 不存在而回落到该维度第一个 scope，这里把选择器同步过去。
  // 反向也要处理：切换维度后旧 scope 不属于新维度（服务端返回 scope=null），
  // 必须清空让服务端重新选，否则会一直停在 dimension_unavailable。
  useEffect(() => {
    if (!data) return;
    const nextKey = data.scope?.quotaKey || '';
    if (nextKey && nextKey !== scopeKey) {
      setScopeKey(nextKey);
      return;
    }
    const selected = data.dimensions.find((dimension) => dimension.windowMinutes === windowMinutes);
    if (!nextKey && scopeKey && selected?.available) setScopeKey('');
  }, [data, scopeKey, windowMinutes]);

  const dimensionOptions = useMemo(() => QUOTA_DIMENSION_OPTIONS.map((option) => {
    const dimension = data?.dimensions.find((item) => item.windowMinutes === option.value);
    return {
      ...option,
      label: dimension && !dimension.available ? `${option.label}（无）` : option.label,
      disabled: Boolean(dimension && !dimension.available)
    };
  }), [data]);

  const currentDimension = data?.dimensions.find((item) => item.windowMinutes === windowMinutes);
  const scopeOptions = useMemo(() => (currentDimension?.scopes || []).map((scope) => ({
    label: scope.label || scope.quotaKey,
    value: scope.quotaKey
  })), [currentDimension]);

  const summary = data?.summary;
  const current = data?.current;
  const costText = summary && summary.costKnown && summary.totalCostUsd != null
    ? formatCost(summary.totalCostUsd)
    : '—';
  const avgTokensText = summary && summary.avgTokensPerWindow != null
    ? formatTokens(summary.avgTokensPerWindow)
    : '—';

  return (
    <PageScaffold
      ghost
      code="QUOTA"
      title={`额度统计 · ${provider || '账号'}`}
      subTitle={(
        <Tooltip title={accountRef}>
          <span>{shortenAccountRef(accountRef)} · 按窗口期统计额度消耗、Tokens 与成本</span>
        </Tooltip>
      )}
      extra={isMobile ? (
        <div className="m-header-actions">
          <MobileBackButton className="m-icon-btn" title="返回账号" onClick={() => navigate('/accounts')} />
          <button
            className="m-icon-btn primary"
            aria-label="刷新额度统计"
            disabled={loading}
            onClick={() => void reload()}
          >
            <ReloadOutlined spin={loading} />
          </button>
        </div>
      ) : [
        <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
          返回账号
        </Button>,
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void reload()}
        >
          刷新
        </Button>
      ]}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message="额度统计加载失败"
          description={error}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <section className="usage-kpi-rail" aria-label="额度窗口核心指标">
        <div className="usage-kpi-item usage-kpi-item--primary">
          <span>当前剩余</span>
          <strong>{formatQuotaPct(current?.remainingPct)}</strong>
          <small>
            {current?.resetAtMs
              ? `下次关窗 ${formatQuotaClock(current.resetAtMs)}`
              : '暂无活跃窗口'}
          </small>
        </div>
        <div className="usage-kpi-item">
          <span>窗口数</span>
          <strong>{summary?.windowCount ?? 0}</strong>
          <small>有完整消耗数据 {summary?.coveredWindowCount ?? 0}</small>
        </div>
        <div className="usage-kpi-item">
          <span>平均消耗</span>
          <strong>{formatQuotaPct(summary?.avgConsumedPct)}</strong>
          <small>峰值 {formatQuotaPct(summary?.maxConsumedPct)}</small>
        </div>
        <div className="usage-kpi-item">
          <span>总 Tokens</span>
          <strong>{formatTokens(summary?.totalTokens ?? 0)}</strong>
          <small>每窗均 {avgTokensText}</small>
        </div>
        <div className="usage-kpi-item usage-kpi-item--cost">
          <span>估算成本</span>
          <strong>{costText}</strong>
          <small>USD · 按当前价格快照</small>
        </div>
        <div className="usage-kpi-item">
          <span>请求数</span>
          <strong>{summary?.requestCount ?? 0}</strong>
          <small>
            {summary?.lastResetAtMs
              ? `最近重置 ${formatQuotaClock(summary.lastResetAtMs)}`
              : '范围内无重置'}
          </small>
        </div>
      </section>

      <SectionCard bordered>
        <Space size={12} wrap className="quota-stats-toolbar">
          <Segmented
            value={windowMinutes}
            options={dimensionOptions}
            onChange={(value) => {
              // 换维度时清掉 scope：不同窗口长度的 quotaKey 不通用，
              // 留着旧值会让服务端多走一次「scope 不存在」的空请求。
              setScopeKey('');
              setWindowMinutes(Number(value));
            }}
          />
          <Segmented
            value={rangeDays}
            options={QUOTA_RANGE_OPTIONS}
            onChange={(value) => setRangeDays(Number(value))}
          />
          {scopeOptions.length > 1 ? (
            <Select
              value={scopeKey || undefined}
              options={scopeOptions}
              onChange={(value) => setScopeKey(value)}
              style={{ minWidth: 180 }}
              placeholder="额度范围"
            />
          ) : null}
          <Typography.Text type="secondary" className="quota-stats-note">
            窗口由关闭后的第一个真实请求锚定，不会按日历滚动；空闲期的 reset 是幻影，已剔除。
          </Typography.Text>
        </Space>
      </SectionCard>

      <SectionCard className="usage-insights-card" bodyStyle={{ padding: 0 }}>
        <QuotaWindowChart
          windows={data?.windows || []}
          windowMinutes={windowMinutes}
          emptyReason={data?.emptyReason || null}
        />
      </SectionCard>

      <SectionCard
        title="窗口明细"
        extra={loading ? <Typography.Text type="secondary">更新中…</Typography.Text> : null}
      >
        <QuotaWindowTable windows={data?.windows || []} loading={loading} />
        <Typography.Text type="secondary" className="quota-stats-footnote">
          仅统计能归属到本账号的用量记录；未归属的历史会话不计入。历史窗口由重置事件与用量记录尽力重建，
          标注「仅重置事件 / 重建」的行是估算值。
        </Typography.Text>
      </SectionCard>
    </PageScaffold>
  );
}
