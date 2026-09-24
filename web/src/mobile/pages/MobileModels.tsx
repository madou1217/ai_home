import { CopyOutlined, ExportOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Input, Select, message } from 'antd';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import {
  MODEL_PROVIDERS,
  MODEL_STATUS_FILTER_OPTIONS,
  formatCatalogJobStatus,
  formatCatalogProbeScope,
  formatUpdatedAt,
  getAccountLabel,
  getCatalogJobVisibleCount,
  getGlobalModelDisplayLabel,
  isGlobalModelVisible,
  normalizeProvider,
  type GlobalModelRow,
  type ModelStatusFilter,
  type ProviderFilter
} from '@/features/models/model-catalog';
import { useModelCatalogPage, type ManualModelValues } from '@/features/models/use-model-catalog-page';
import MobileBoot from '@/mobile/MobileBoot';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  EmptySignal,
  HudCard,
  HudChips,
  HudIconButton,
  HudSection,
  KeyValue,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import { openExternalUrl } from '@/services/open-external-url';
import { parseUpstreamError } from '@/utils/format-upstream-error';
import ManualModelSheet from './models/ManualModelSheet';
import ModelRowSheet from './models/ModelRowSheet';
import styles from './models/MobileModels.module.css';

/** 列表分段渲染：每次多渲染一段，避免几百个模型一次性挂载。 */
const PAGE_STEP = 40;

async function copyText(text: string, success: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(success);
  } catch (_error) {
    message.error('复制失败');
  }
}

/**
 * 移动端全局模型目录（/models）。数据与动作全部来自 useModelCatalogPage
 * （modelsAPI.listOpenAICompatible / watchOpenAICompatibleRefresh / createManualModel），
 * 聚合与筛选口径与桌面 Models.tsx 全局分支共用 features/models/model-catalog。
 */
export default function MobileModels(_props: MobilePageProps) {
  const [searchParams] = useSearchParams();
  const queryFilters = useMemo(() => ({
    provider: normalizeProvider(searchParams.get('provider')),
    account: searchParams.get('accountRef') || 'all'
  }), [searchParams]);
  const page = useModelCatalogPage(queryFilters);
  const [limit, setLimit] = useState(PAGE_STEP);
  const [detailRow, setDetailRow] = useState<GlobalModelRow | null>(null);
  const [manualDefaults, setManualDefaults] = useState<ManualModelValues | null>(null);

  const { catalog, catalogJob } = page;
  const refreshing = page.loading || page.catalogJobActive;
  const visibleRows = page.rows.slice(0, limit);
  const probeError = page.probeError ? parseUpstreamError(page.probeError) : null;

  const providerChips = useMemo(() => [
    { key: 'all', label: '全部', count: page.providerCounts.all || 0 },
    ...MODEL_PROVIDERS.map((provider) => ({
      key: provider,
      label: providerNames[provider],
      count: page.providerCounts[provider] || 0,
      icon: <ProviderIcon provider={provider} size={14} />
    }))
  ], [page.providerCounts]);

  const accountSelectOptions = useMemo(() => [
    { label: '全部账号', value: 'all' },
    ...page.filteredAccountOptions.map((account) => ({
      label: (
        <span className={styles.accountOption}>
          <ProviderIcon provider={account.provider} size={14} />
          <span>{getAccountLabel(account)}</span>
        </span>
      ),
      value: account.accountRef
    }))
  ], [page.filteredAccountOptions]);

  const openManual = () => {
    const defaults = page.getManualModelDefaults();
    if (defaults) setManualDefaults(defaults);
  };

  const resetLimit = () => setLimit(PAGE_STEP);

  if (!page.loaded && !catalog) return <MobileBoot label="LOADING MODELS" />;

  return (
    <MobilePage
      lead="按模型聚合展示可见状态；客户端看到的是所有启用账号模型的去重合集。"
      toolbar={(
        <MobileToolbar
          start={(
            <span className={styles.sourceLine}>
              <span className={`hud-led ${catalog?.cached ? 'hud-led--info' : 'hud-led--ok hud-led--live'}`} aria-hidden="true" />
              {catalog?.cached ? '缓存' : '实时'} · {formatUpdatedAt(catalog?.updatedAt)}
            </span>
          )}
        >
          <HudIconButton
            icon={<PlusOutlined />}
            label={page.canCreateManualModel ? '添加模型' : '没有可添加模型的账号'}
            disabled={!page.canCreateManualModel}
            onClick={openManual}
          />
          <HudIconButton
            icon={<ReloadOutlined />}
            label="刷新模型"
            tone="primary"
            loading={refreshing}
            onClick={page.refreshModels}
          />
        </MobileToolbar>
      )}
    >
      <TelemetryGrid>
        <TelemetryTile label="账号模型" value={page.accountModelCount} tone="info" />
        <TelemetryTile label="可见模型" value={page.visibleModelCount} tone="ok" led />
        <TelemetryTile label="手动补充" value={page.manualModelCount} tone="muted" wide />
      </TelemetryGrid>

      {probeError ? (
        <HudCard code="PROBE" title="部分账号模型探测失败" tone={catalog?.source === 'remote' ? 'warn' : 'err'}>
          <div className={styles.probeBody} role="status">
            {probeError.statusCode ? <span className={styles.probeCode}>HTTP {probeError.statusCode}</span> : null}
            <p className={styles.probeMessage}>{probeError.message}</p>
            <div className={styles.cardActions}>
              {probeError.url ? (
                <HudIconButton
                  icon={<ExportOutlined />}
                  label="提交上游 issue"
                  showLabel
                  onClick={() => {
                    void openExternalUrl(probeError.url).catch(() => message.error('无法打开外部链接'));
                  }}
                />
              ) : null}
              <HudIconButton
                icon={<CopyOutlined />}
                label="原始错误"
                showLabel
                onClick={() => copyText(probeError.raw, '已复制')}
              />
            </div>
          </div>
        </HudCard>
      ) : null}

      {catalogJob ? (
        <HudCard
          code="REFRESH"
          title="刷新状态"
          tone={catalogJob.status === 'failed' ? 'err' : catalogJob.status === 'succeeded' ? 'ok' : 'info'}
          extra={(
            <span className={`mhud-status mhud-tone--${catalogJob.status === 'failed' ? 'err' : page.catalogJobActive ? 'info' : 'ok'}`}>
              <span
                className={`hud-led ${catalogJob.status === 'failed' ? 'hud-led--err' : page.catalogJobActive ? 'hud-led--info hud-led--live' : 'hud-led--ok'}`}
                aria-hidden="true"
              />
              {formatCatalogJobStatus(catalogJob)}
            </span>
          )}
        >
          <KeyValue
            rows={[
              { key: 'scope', label: '探测范围', value: formatCatalogProbeScope(catalogJob), mono: false },
              { key: 'visible', label: '可见模型', value: getCatalogJobVisibleCount(catalogJob) ?? '-' },
              { key: 'scanned', label: '探测账号', value: catalogJob.catalog?.scannedAccounts ?? '-' }
            ]}
          />
          {catalogJob.error ? <p className={styles.jobError}>{catalogJob.error}</p> : null}
        </HudCard>
      ) : null}

      <HudSection
        title="模型目录"
        code="CATALOG"
        count={page.rows.length}
      >
        <p className={styles.catalogMeta}>
          端点 {catalog?.endpoint || '/v1/models'}，当前可见模型 {page.visibleModelCount} 个。
        </p>

        <div className={styles.filters}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索模型 ID"
            aria-label="搜索模型 ID"
            value={page.keyword}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              page.setKeyword(event.target.value);
              resetLimit();
            }}
          />
          <HudChips
            ariaLabel="按 Provider 筛选"
            items={providerChips}
            value={page.providerFilter}
            onChange={(key) => {
              page.setProviderFilter(key as ProviderFilter);
              resetLimit();
            }}
          />
          <Select
            className={styles.fullWidth}
            aria-label="按账号筛选"
            value={page.accountFilter}
            options={accountSelectOptions}
            onChange={(value) => {
              page.setAccountFilter(value);
              resetLimit();
            }}
          />
          <HudChips
            ariaLabel="按状态筛选"
            items={MODEL_STATUS_FILTER_OPTIONS.map((option) => ({ key: option.value, label: option.label }))}
            value={page.statusFilter}
            onChange={(key) => {
              page.setStatusFilter(key as ModelStatusFilter);
              resetLimit();
            }}
          />
        </div>

        {page.rows.length === 0 ? (
          page.loadError && !catalog ? (
            <EmptySignal
              title="LINK ERROR"
              description={page.loadError}
              action={<HudIconButton icon={<ReloadOutlined />} label="重试" tone="primary" showLabel onClick={() => page.loadModels({ quiet: true })} />}
            />
          ) : (
            <EmptySignal
              description="暂无数据"
              action={page.canCreateManualModel ? (
                <HudIconButton icon={<PlusOutlined />} label="添加模型" tone="primary" showLabel onClick={openManual} />
              ) : null}
            />
          )
        ) : (
          <MonoList ariaLabel="模型目录">
            {visibleRows.map((row) => {
              const visible = isGlobalModelVisible(row);
              const displayLabel = getGlobalModelDisplayLabel(catalog, row);
              const providerText = row.providers.length > 0
                ? row.providers.map((provider) => providerNames[provider] || provider).join(' / ')
                : '未知来源';
              return (
                <SwipeRow
                  key={row.id}
                  ariaLabel={`${displayLabel || row.id} 详情`}
                  onTap={() => setDetailRow(row)}
                  actions={[{
                    key: 'copy',
                    label: '复制 ID',
                    icon: <CopyOutlined />,
                    tone: 'primary',
                    onAction: () => page.copyModelId(row.id)
                  }]}
                >
                  <span className={`mhud-row__icon${visible ? '' : ` ${styles.rowHidden}`}`}>
                    <ProviderIcon provider={row.providers[0] || row.owned_by || 'ai'} size={20} />
                  </span>
                  <span className={`mhud-row__main${visible ? '' : ` ${styles.rowHidden}`}`}>
                    <span className="mhud-row__title">{displayLabel || row.id}</span>
                    <span className="mhud-row__meta">
                      {displayLabel ? `${row.id} · ` : ''}{providerText}
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status ${visible ? 'mhud-tone--ok' : 'mhud-tone--muted'}`}>
                      <span className={`hud-led ${visible ? 'hud-led--ok' : 'hud-led--warn'}`} aria-hidden="true" />
                      {visible ? 'VIS' : 'HID'}
                    </span>
                    <span className={styles.sideCount}>
                      {row.enabledCount}/{row.enabledCount + row.disabledCount}
                      {row.manualCount > 0 ? <span className={styles.manualTag}> M{row.manualCount}</span> : null}
                    </span>
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}

        {page.rows.length > visibleRows.length ? (
          <div className={styles.more}>
            <HudIconButton
              icon={null}
              label={`加载更多（${visibleRows.length}/${page.rows.length}）`}
              showLabel
              onClick={() => setLimit((current) => current + PAGE_STEP)}
            />
          </div>
        ) : null}
      </HudSection>

      <ModelRowSheet
        row={detailRow}
        displayLabel={detailRow ? getGlobalModelDisplayLabel(catalog, detailRow) : ''}
        onClose={() => setDetailRow(null)}
        onCopyId={page.copyModelId}
      />

      <ManualModelSheet
        open={Boolean(manualDefaults)}
        defaults={manualDefaults}
        accountOptions={page.accountOptions}
        accountByRef={page.accountByRef}
        providerOptions={page.manualProviderOptions}
        onClose={() => setManualDefaults(null)}
        onSubmit={page.submitManualModel}
      />
    </MobilePage>
  );
}
