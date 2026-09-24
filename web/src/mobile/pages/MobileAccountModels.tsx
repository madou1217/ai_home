import { useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { Input, Switch, message } from 'antd';
import {
  ArrowLeftOutlined,
  CopyOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  StarOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  EmptySignal,
  HudCard,
  HudChips,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { HudChipItem, SwipeAction } from '@/mobile/ui';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import MobileBoot from '@/mobile/MobileBoot';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import { parseUpstreamError } from '@/utils/format-upstream-error';
import { openExternalUrl } from '@/services/open-external-url';
import type { ManagedOpenAIModelItem } from '@/types';
import {
  MODEL_STATUS_FILTER_OPTIONS,
  formatCatalogJobStatus,
  formatCatalogProbeScope,
  formatUpdatedAt,
  getCatalogJobVisibleCount,
  type ModelStatusFilter
} from '@/features/models/model-catalog';
import { getModelRowKey, type ModelGroupFilter } from '@/features/models/account-models';
import { useAccountModels } from '@/features/models/use-account-models';
import AccountModelSheet from './accounts/AccountModelSheet';
import AccountManualModelSheet from './accounts/AccountManualModelSheet';
import styles from './MobileAccountModels.module.css';

const stopRowGesture = (event: MouseEvent | PointerEvent) => event.stopPropagation();

/**
 * /accounts/:provider/:accountRef/models 移动端：账号头卡 + 探测遥测 + 模型等宽列表（行内启停开关、
 * 左滑设默认 / 复制、点按详情），工具条：返回账号 / 手动添加 / 账号模型探测。
 * 数据与动作来自 features/models/use-account-models（与桌面 Models.tsx 账号分支同一套 API 与文案）。
 */
export default function MobileAccountModels({ params }: MobilePageProps) {
  const navigate = useNavigate();
  const state = useAccountModels({ provider: params.provider, accountRef: params.accountRef });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const selectedModel = selectedKey
    ? state.rows.find((model) => getModelRowKey(model) === selectedKey) || null
    : null;
  const jobActive = state.catalogJobActive;
  const providerLabel = state.scopedProvider ? (providerNames[state.scopedProvider] || state.scopedProvider) : '';

  const backToAccounts = () => navigate('/accounts');

  const openManual = () => {
    if (!state.canCreateManualModel) {
      message.warning('未找到当前账号');
      return;
    }
    setManualOpen(true);
  };

  const toolbar = (
    <MobileToolbar
      start={<HudIconButton icon={<ArrowLeftOutlined />} label="返回账号" showLabel onClick={backToAccounts} />}
    >
      <HudIconButton
        icon={<PlusOutlined />}
        label="添加模型"
        disabled={!state.accountScoped || !state.canCreateManualModel}
        onClick={openManual}
      />
      <HudIconButton
        icon={<ReloadOutlined spin={state.loading || jobActive} />}
        label="刷新模型"
        tone="primary"
        disabled={!state.accountScoped || state.loading || jobActive}
        onClick={() => { void state.refreshModels(); }}
      />
    </MobileToolbar>
  );

  if (!state.accountScoped) {
    return (
      <MobilePage toolbar={toolbar}>
        <EmptySignal
          title="NO ACCOUNT"
          description="当前账号缺少公开引用，请从账号列表重新进入"
          action={<HudIconButton icon={<ArrowLeftOutlined />} label="返回账号" showLabel onClick={backToAccounts} />}
        />
      </MobilePage>
    );
  }

  const probeError = state.probeError ? parseUpstreamError(state.probeError) : null;

  const statusChips: HudChipItem[] = MODEL_STATUS_FILTER_OPTIONS.map((option) => ({
    key: option.value,
    label: option.label
  }));
  const groupChips: HudChipItem[] = [
    { key: 'all', label: '全部分组', count: state.accountModelCount },
    { key: 'go', label: 'Go 订阅', count: state.openCodeGroupCounts.go },
    { key: 'zen', label: 'Zen 按量', count: state.openCodeGroupCounts.zen },
    ...(state.openCodeGroupCounts.free > 0
      ? [{ key: 'free', label: 'Free 免费', count: state.openCodeGroupCounts.free }]
      : [])
  ];

  const buildSwipeActions = (model: ManagedOpenAIModelItem): SwipeAction[] => {
    const enabled = model.enabled !== false;
    return [
      {
        key: 'default',
        label: '设默认',
        icon: <StarOutlined />,
        tone: 'primary',
        disabled: Boolean(model.defaultModel) || !enabled,
        onAction: () => { void state.updateModelDefault(model, true); }
      },
      {
        key: 'copy',
        label: '复制',
        icon: <CopyOutlined />,
        onAction: () => { void state.copyModelId(model.id); }
      }
    ];
  };

  const copyRawProbeError = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw);
      message.success('已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  };

  return (
    <MobilePage toolbar={toolbar}>
      <HudCard
        code={String(state.scopedProvider || '').toUpperCase()}
        title={state.accountTitle}
        extra={(
          <span className={`mhud-status ${state.catalog?.cached ? 'mhud-tone--muted' : 'mhud-tone--info'}`}>
            <span className={`hud-led${state.catalog?.cached ? '' : ' hud-led--info'}`} aria-hidden="true" />
            {state.catalog?.cached ? '缓存' : '实时'}
          </span>
        )}
      >
        <div className={styles.accountHead}>
          {state.scopedProvider ? <ProviderIcon provider={state.scopedProvider} size={22} /> : null}
          <span className={styles.accountDesc}>
            独立模型开关和手动补充 · 更新时间 {formatUpdatedAt(state.catalog?.updatedAt)}
          </span>
        </div>
      </HudCard>

      <TelemetryGrid>
        <TelemetryTile label="账号模型" value={state.accountModelCount} tone="info" />
        <TelemetryTile label="启用模型" value={state.enabledModelCount} tone={state.enabledModelCount > 0 ? 'ok' : 'muted'} led />
        <TelemetryTile label="手动补充" value={state.manualModelCount} tone="muted" />
        <TelemetryTile
          label="刷新状态"
          value={formatCatalogJobStatus(state.catalogJob)}
          tone={state.catalogJob?.status === 'failed' ? 'err' : jobActive ? 'info' : 'muted'}
          led={jobActive ? 'live' : Boolean(state.catalogJob)}
          sub={state.catalogJob
            ? `${formatCatalogProbeScope(state.catalogJob)} · 可见 ${getCatalogJobVisibleCount(state.catalogJob) ?? '-'} · 探测账号 ${state.catalogJob.catalog?.scannedAccounts ?? '-'}`
            : undefined}
        />
      </TelemetryGrid>

      {state.catalogJob?.error ? (
        <p className={`${styles.jobError} mhud-tone--err`} role="alert">{state.catalogJob.error}</p>
      ) : null}

      {probeError ? (
        <HudCard code="PROBE" title="部分账号模型探测失败" tone={state.catalog?.source === 'remote' ? 'warn' : 'err'}>
          <div className={styles.probeError}>
            {probeError.statusCode ? <span className="mhud-status mhud-tone--err">HTTP {probeError.statusCode}</span> : null}
            <p className={styles.probeMessage}>{probeError.message}</p>
            <div className={styles.probeActions}>
              {probeError.url ? (
                <HudIconButton
                  icon={<ExportOutlined />}
                  label="提交上游 issue"
                  showLabel
                  onClick={() => { void openExternalUrl(probeError.url).catch(() => message.error('无法打开外部链接')); }}
                />
              ) : null}
              <HudIconButton
                icon={<CopyOutlined />}
                label="复制原始错误"
                showLabel
                onClick={() => { void copyRawProbeError(probeError.raw); }}
              />
            </div>
          </div>
        </HudCard>
      ) : null}

      <HudSection title="当前账号模型" code="MODELS" count={state.rows.length}>
        <Input
          allowClear
          value={state.keyword}
          placeholder="搜索模型"
          aria-label="搜索模型"
          onChange={(event) => state.setKeyword(event.target.value)}
        />
        {state.isOpenCode ? (
          <HudChips
            ariaLabel="OpenCode 模型分组"
            items={groupChips}
            value={state.groupFilter}
            onChange={(key) => state.setGroupFilter(key as ModelGroupFilter)}
          />
        ) : null}
        <HudChips
          ariaLabel="按状态筛选模型"
          items={statusChips}
          value={state.statusFilter}
          onChange={(key) => state.setStatusFilter(key as ModelStatusFilter)}
        />

        {!state.loaded && state.loading ? (
          <MobileBoot label="LOADING MODELS" />
        ) : state.loadError && !state.catalog ? (
          <EmptySignal
            title="LINK ERROR"
            description={state.loadError}
            action={(
              <HudIconButton
                icon={<ReloadOutlined />}
                label="重试"
                showLabel
                onClick={() => { void state.loadModels({ quiet: true }); }}
              />
            )}
          />
        ) : state.rows.length === 0 ? (
          <EmptySignal
            description="暂无数据"
            action={(
              <HudIconButton
                icon={<ReloadOutlined />}
                label="探测账号模型"
                showLabel
                disabled={jobActive}
                onClick={() => { void state.refreshModels(); }}
              />
            )}
          />
        ) : (
          <MonoList ariaLabel="账号模型列表">
            {state.rows.map((model) => {
              const rowKey = getModelRowKey(model);
              const enabled = model.enabled !== false;
              const displayLabel = state.getModelDisplayLabel(model);
              const flags = [
                displayLabel ? model.id : '',
                model.defaultModel ? '默认' : '',
                model.manual ? '手动' : '',
                enabled ? '' : '停用'
              ].filter(Boolean).join(' · ');
              return (
                <SwipeRow
                  key={rowKey}
                  actions={buildSwipeActions(model)}
                  onTap={() => setSelectedKey(rowKey)}
                  ariaLabel={`查看模型 ${model.id}`}
                >
                  <span className={`mhud-row__main${enabled ? '' : ` ${styles.disabledRow}`}`}>
                    <span className="mhud-row__title">{displayLabel || model.id}</span>
                    {flags ? <span className="mhud-row__meta">{flags}</span> : null}
                  </span>
                  <span
                    className={styles.switchSlot}
                    onClick={stopRowGesture}
                    onPointerDown={stopRowGesture}
                  >
                    <Switch
                      checked={enabled}
                      aria-label={enabled ? `停用 ${model.id}` : `启用 ${model.id}`}
                      onChange={(checked) => { void state.updateModelEnabled(model, checked); }}
                    />
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
      </HudSection>

      <AccountModelSheet
        model={selectedModel}
        displayLabel={selectedModel ? state.getModelDisplayLabel(selectedModel) : ''}
        onClose={() => setSelectedKey(null)}
        onToggleEnabled={(model, enabled) => { void state.updateModelEnabled(model, enabled); }}
        onSetDefault={(model) => { void state.updateModelDefault(model, true); }}
        onCopyId={(modelId) => { void state.copyModelId(modelId); }}
      />
      <AccountManualModelSheet
        open={manualOpen}
        providerLabel={providerLabel}
        accountLabel={state.accountTitle}
        onClose={() => setManualOpen(false)}
        onSubmit={state.createManualModel}
      />
    </MobilePage>
  );
}
