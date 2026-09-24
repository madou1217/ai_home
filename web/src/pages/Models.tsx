import ModelCapsuleCard from '@/components/models/ModelCapsuleCard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@/components/mobile/mobile-icon-button.css';
import './Models.css';
import '@/components/ui/kpi-strip.css';
import { Form, Input, Segmented, Select, Switch, Tag, Tooltip, Typography, message, Grid } from 'antd';
import { ApiOutlined, ArrowLeftOutlined, CopyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { modelsAPI } from '@/services/api';
import type {
  ManagedOpenAIModelItem,
  Provider,
  WebUiOpenAIModelAccount,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsResponse
} from '@/types';
import Button from '@/components/ui/AppButton';
import DataToolbar from '@/components/ui/DataToolbar';
import PaginatedList from '@/components/ui/PaginatedList';
import { ModalForm, StatisticCard } from '@ant-design/pro-components';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import {
  DEFAULT_MANUAL_MODEL_PROVIDER,
  MODEL_PROVIDERS,
  MODEL_STATUS_FILTER_OPTIONS,
  buildGlobalModelRows,
  buildManualProviderOptions,
  buildModelAccountOptions,
  countGlobalModelRowsByProvider,
  filterGlobalModelRows,
  formatCatalogJobStatus,
  formatCatalogProbeScope,
  formatUpdatedAt,
  getAccountLabel,
  getCatalogJobScopeKey,
  getCatalogJobVisibleCount,
  getGlobalModelDisplayLabel,
  getManagedModelSource,
  getModelDisplayLabel as getCatalogModelDisplayLabel,
  getVisibleModelProbeError,
  isCatalogJobActive,
  isGlobalModelVisible,
  normalizeProvider,
  pickLatestCatalogJob,
  resolveManualModelAccountForProvider,
  resolveManualModelDefaults,
  type AccountFilter,
  type GlobalModelRow,
  type ModelStatusFilter,
  type ProviderFilter
} from '@/features/models/model-catalog';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import { parseUpstreamError } from '@/utils/format-upstream-error';
import { openExternalUrl } from '@/services/open-external-url';
import {
  countOpenCodeGroups,
  filterAccountModelRows,
  formatScopedAccountTitle,
  getModelRowKey,
  type ModelGroupFilter
} from '@/features/models/account-models';


export default function Models() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const routeParams = useParams<{ provider?: string; accountRef?: string }>();
  const routeProvider = normalizeProvider(routeParams.provider || null);
  const routeAccountRef = String(routeParams.accountRef || '').trim();
  const scopedProvider = routeProvider === 'all' ? null : routeProvider;
  const scopedAccountRef = routeAccountRef;
  const accountScoped = Boolean(scopedProvider && scopedAccountRef);
  const pageScopeKey = accountScoped ? scopedAccountRef : 'global';
  const [catalog, setCatalog] = useState<WebUiOpenAIModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogJob, setCatalogJob] = useState<WebUiOpenAIModelsJob | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(() => scopedProvider || normalizeProvider(searchParams.get('provider')));
  const [accountFilter, setAccountFilter] = useState<AccountFilter>(() => scopedAccountRef || searchParams.get('accountRef') || 'all');
  const [statusFilter, setStatusFilter] = useState<ModelStatusFilter>('all');
  const [groupFilter, setGroupFilter] = useState<ModelGroupFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualForm] = Form.useForm();
  const manualProvider = Form.useWatch('provider', manualForm) as Provider | undefined;
  const [queryKeyword, setQueryKeyword] = useState('');
  const completedCatalogJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = window.setTimeout(() => setQueryKeyword(keyword), 220);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (accountScoped && scopedProvider) {
      setProviderFilter(scopedProvider);
      setAccountFilter(scopedAccountRef || 'all');
      return;
    }
    setProviderFilter(normalizeProvider(searchParams.get('provider')));
    setAccountFilter(searchParams.get('accountRef') || 'all');
  }, [accountScoped, scopedAccountRef, scopedProvider, searchParams]);

  const buildCatalogRequestOptions = useCallback(() => {
    if (!accountScoped || !scopedAccountRef) return {};
    return {
      accountRef: scopedAccountRef
    };
  }, [accountScoped, scopedAccountRef]);

  const loadModels = useCallback(async (options: { refresh?: boolean; quiet?: boolean } = {}) => {
    setLoading(true);
    try {
      const payload = await modelsAPI.listOpenAICompatible(buildCatalogRequestOptions());
      setCatalog(payload);
      if (!options.quiet) {
        message.success('模型缓存已重新读取');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '加载模型目录失败');
    } finally {
      setLoading(false);
    }
  }, [accountScoped, buildCatalogRequestOptions]);

  useEffect(() => {
    loadModels({ quiet: true });
  }, [loadModels]);

  const handleCatalogJobUpdate = useCallback((job: WebUiOpenAIModelsJob) => {
    if (getCatalogJobScopeKey(job) !== pageScopeKey) return;
    setCatalogJob(job);
    if (job.catalog) setCatalog(job.catalog);
    if (job.status !== 'succeeded' && job.status !== 'failed') return;
    if (!job.id || completedCatalogJobIdsRef.current.has(job.id)) return;
    completedCatalogJobIdsRef.current.add(job.id);
    if (job.status === 'succeeded') {
      message.success(accountScoped ? '账号模型已刷新' : '模型目录已刷新');
      return;
    }
    message.error(job.error || '刷新模型目录失败');
  }, [accountScoped, pageScopeKey]);

  useEffect(() => {
    const watcher = modelsAPI.watchOpenAICompatibleRefresh({
      onSnapshot: (jobs) => {
        const latest = pickLatestCatalogJob(jobs, pageScopeKey);
        if (!latest) return;
        setCatalogJob(latest);
        if (latest.catalog) setCatalog(latest.catalog);
      },
      onJob: handleCatalogJobUpdate
    });
    return () => watcher.close();
  }, [handleCatalogJobUpdate, pageScopeKey]);

  const refreshModels = useCallback(async () => {
    if (!accountScoped) {
      await loadModels();
      return;
    }
    if (!scopedAccountRef) {
      message.error('当前账号缺少公开引用，请从账号列表重新进入');
      return;
    }
    setLoading(true);
    try {
      const response = await modelsAPI.refreshOpenAICompatible(buildCatalogRequestOptions());
      setCatalogJob(response.job || null);
      if (response.job?.catalog) setCatalog(response.job.catalog);
      message.info(response.alreadyRunning ? '账号模型探测已在进行' : '账号模型探测已开始');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '刷新模型目录失败');
    } finally {
      setLoading(false);
    }
  }, [accountScoped, buildCatalogRequestOptions, loadModels, scopedAccountRef]);

  const managedSource = useMemo<ManagedOpenAIModelItem[]>(() => getManagedModelSource(catalog), [catalog]);

  const accountOptions = useMemo<WebUiOpenAIModelAccount[]>(() => buildModelAccountOptions(
    catalog,
    managedSource,
    accountScoped && scopedProvider && scopedAccountRef ? { provider: scopedProvider, accountRef: scopedAccountRef } : null
  ), [accountScoped, catalog, managedSource, scopedAccountRef, scopedProvider]);

  const accountByRef = useMemo(() => {
    return new Map(accountOptions.map((account) => [account.accountRef, account]));
  }, [accountOptions]);

  const scopedAccount = scopedAccountRef ? accountByRef.get(scopedAccountRef) : null;
  const scopedAccountLabel = scopedAccount ? getAccountLabel(scopedAccount) : scopedAccountRef;
  const scopedAccountTitle = formatScopedAccountTitle(scopedAccountLabel, scopedProvider);

  useEffect(() => {
    if (!manualModalOpen) return;
    const provider = manualProvider || DEFAULT_MANUAL_MODEL_PROVIDER;
    const source = accountScoped && scopedAccount
      ? [scopedAccount]
      : accountOptions;
    const next = resolveManualModelAccountForProvider(
      source,
      accountByRef,
      provider,
      String(manualForm.getFieldValue('accountRef') || '')
    );
    if (!next.changed) return;
    manualForm.setFieldsValue({ accountRef: next.accountRef });
  }, [accountByRef, accountOptions, accountScoped, manualForm, manualModalOpen, manualProvider, scopedAccount]);

  const openManualModal = useCallback(() => {
    const selectedAccount = accountScoped
      ? accountByRef.get(scopedAccountRef)
      : accountFilter !== 'all' ? accountByRef.get(accountFilter) : null;
    if (accountOptions.length < 1) {
      message.warning('没有可添加模型的账号');
      return;
    }
    const preferredProvider = accountScoped && scopedProvider
      ? scopedProvider
      : selectedAccount?.provider || (providerFilter === 'all' ? DEFAULT_MANUAL_MODEL_PROVIDER : providerFilter);
    manualForm.setFieldsValue(resolveManualModelDefaults(accountOptions, selectedAccount, preferredProvider));
    setManualModalOpen(true);
  }, [accountByRef, accountFilter, accountOptions, accountScoped, manualForm, providerFilter, scopedAccountRef, scopedProvider]);

  const submitManualModel = useCallback(async (submittedValues?: Record<string, any>) => {
    const values = submittedValues && typeof submittedValues === 'object'
      ? submittedValues
      : await manualForm.validateFields();
    const account = accountByRef.get(values.accountRef);
    if (!account) {
      message.error('请选择有效账号');
      return false;
    }
    try {
      await modelsAPI.createManualModel({
        id: values.id,
        provider: account?.provider || values.provider,
        accountRef: values.accountRef,
        description: values.description,
        enabled: values.enabled !== false
      });
      message.success('模型已添加');
      setManualModalOpen(false);
      manualForm.resetFields();
      await loadModels({ quiet: true });
      return true;
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '添加模型失败');
      return false;
    }
  }, [accountByRef, loadModels, manualForm]);

  const updateModelEnabled = useCallback(async (model: ManagedOpenAIModelItem, enabled: boolean) => {
    try {
      await modelsAPI.updateModel({
        id: model.id,
        accountRef: model.accountRef,
        provider: model.provider,
        enabled
      });
      message.success(enabled ? '模型已启用' : '模型已停用');
      await loadModels({ quiet: true });
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '更新模型状态失败');
    }
  }, [loadModels]);

  const updateModelDefault = useCallback(async (model: ManagedOpenAIModelItem, checked: boolean) => {
    if (!checked) {
      message.info('每个账号保留一个默认模型，请直接切换到其他模型');
      return;
    }
    if (model.enabled === false) {
      message.warning('请先启用模型');
      return;
    }
    try {
      await modelsAPI.updateModel({
        id: model.id,
        accountRef: model.accountRef,
        provider: model.provider,
        enabled: true,
        defaultModel: true
      });
      message.success('默认模型已更新');
      await loadModels({ quiet: true });
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '设置默认模型失败');
    }
  }, [loadModels]);

  const accountModelRows = useMemo(() => filterAccountModelRows(managedSource, {
    provider: providerFilter,
    accountRef: accountFilter,
    status: statusFilter,
    group: groupFilter,
    query: queryKeyword.trim().toLowerCase()
  }, (model) => getAccountLabel(accountByRef.get(model.accountRef) || { provider: model.provider, displayName: '', email: '', accountRef: model.accountRef })), [accountByRef, accountFilter, managedSource, providerFilter, queryKeyword, statusFilter, groupFilter]);

  const globalModelRows = useMemo<GlobalModelRow[]>(
    () => buildGlobalModelRows(catalog, managedSource, accountByRef),
    [accountByRef, catalog, managedSource]
  );

  const globalRows = useMemo(() => filterGlobalModelRows(globalModelRows, {
    provider: providerFilter,
    account: accountFilter,
    status: statusFilter,
    query: queryKeyword.trim().toLowerCase()
  }), [accountFilter, globalModelRows, providerFilter, queryKeyword, statusFilter]);

  const providerCounts = useMemo(() => countGlobalModelRowsByProvider(globalModelRows, {
    account: accountFilter,
    status: statusFilter,
    query: queryKeyword.trim().toLowerCase()
  }), [accountFilter, globalModelRows, queryKeyword, statusFilter]);

  const metricSource = accountScoped
    ? managedSource.filter((model) => model.accountRef === scopedAccountRef)
    : managedSource;

  const isOpenCodeScoped = (accountScoped && scopedProvider === 'opencode') || (!accountScoped && providerFilter === 'opencode');
  const {
    go: openCodeGoCount,
    zen: openCodeZenCount,
    free: openCodeFreeCount
  } = countOpenCodeGroups(metricSource);
  const visibleUnionCount = accountScoped
    ? metricSource.filter((model) => model.enabled !== false).length
    : globalModelRows.filter(isGlobalModelVisible).length;
  const manualCount = metricSource.filter((model) => model.manual).length;
  const globalProbeError = getVisibleModelProbeError(catalog);
  const manualAccountOptionSource = accountScoped && scopedAccount
    ? [scopedAccount]
    : accountOptions.filter((account) => account.provider === (manualProvider || DEFAULT_MANUAL_MODEL_PROVIDER));
  const manualAccountOptions = manualAccountOptionSource
    .map((account) => ({
      label: getAccountLabel(account),
      value: account.accountRef
    }));
  const manualProviderOptions = buildManualProviderOptions(accountOptions);
  const canCreateManualModel = accountScoped
    ? Boolean(scopedAccount)
    : accountOptions.length > 0;
  const manualModelUnavailableReason = accountScoped
    ? '未找到当前账号'
    : '没有可添加模型的账号';

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      message.success('模型 ID 已复制');
    } catch (_error) {
      message.error('复制失败');
    }
  };

  // 上游探测的 display_name(如 kimi 的 "K2.7 Coding")与模型 id 可能完全不同,
  // 标题优先显示 displayName 与 CLI /model 选择器对齐,真实 id 收进副标题。
  const getModelDisplayLabel = (provider: string, id: string) => getCatalogModelDisplayLabel(catalog, provider, id);

  // 手机端头部只放得下图标按钮：这里若沿用带文案的 Button，会和相邻图标按钮
  // 一起把刷新按钮挤出 390px 视口（父容器裁剪，横向溢出门禁看不见）。
  const renderManualModelButton = (iconOnly = false) => (
    <Tooltip title={canCreateManualModel ? '' : manualModelUnavailableReason}>
      <span>
        {iconOnly ? (
          <button
            type="button"
            className="m-icon-btn"
            aria-label="添加模型"
            disabled={!canCreateManualModel}
            onClick={openManualModal}
          >
            <PlusOutlined />
          </button>
        ) : (
          <Button
            disabled={!canCreateManualModel}
            icon={<PlusOutlined />}
            onClick={openManualModal}
          >
            添加模型
          </Button>
        )}
      </span>
    </Tooltip>
  );

  const renderModelRow = (model: ManagedOpenAIModelItem) => {
    const enabled = model.enabled !== false;
    const rowKey = getModelRowKey(model);
    const displayLabel = getModelDisplayLabel(model.provider, model.id);
    return (
      <div key={rowKey} className="models-capsule-slot">
        <ModelCapsuleCard
          modelId={model.id}
          displayName={displayLabel}
          provider={model.provider || model.owned_by || 'ai'}
          accountRef={model.accountRef}
          enabled={enabled}
          isDefault={Boolean(model.defaultModel)}
          onToggleEnabled={(checked) => updateModelEnabled(model, checked)}
          onSetDefault={!model.defaultModel && enabled ? () => updateModelDefault(model, true) : undefined}
          onCopyId={() => copyModelId(model.id)}
        />
      </div>
    );
  };

  const renderGlobalModelRow = (model: GlobalModelRow) => {
    const visible = isGlobalModelVisible(model);
    const displayLabel = getGlobalModelDisplayLabel(catalog, model);
    return (
      <article className={`models-global-row hud-panel hud-panel--sm ${visible ? '' : 'models-global-row--disabled'}`.trim()} key={model.id}>
        <div className="models-global-main">
          <div className="models-global-title-line">
            <h3 title={model.id}>{displayLabel || model.id}</h3>
            <Tooltip title="复制模型 ID">
              <Button
                className="copy-icon-btn"
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyModelId(model.id)}
              />
            </Tooltip>
            <div className="models-global-providers">
              {model.providers.length > 0 ? model.providers.map((provider) => (
                <Tag className="models-provider-tag" key={provider}>
                  <ProviderIcon provider={provider} size={12} />
                  <span>{providerNames[provider]}</span>
                </Tag>
              )) : <Tag>未知来源</Tag>}
              {!visible ? <Tag>不可见</Tag> : null}
              {model.manualCount > 0 ? <Tag color="processing">手动 {model.manualCount}</Tag> : null}
            </div>
          </div>
          <p>
            {displayLabel ? `${model.id} · ` : ''}{model.object} · {model.owned_by || 'aih'} · 启用账号 {model.enabledCount}
            {model.disabledCount > 0 ? ` · 停用账号 ${model.disabledCount}` : ''}
          </p>
        </div>
      </article>
    );
  };

  return (
    <PageScaffold ghost
      code="MODELS"
      title={accountScoped ? '账号模型管理' : '全局模型目录'}
      subTitle={accountScoped
        ? `${scopedAccountTitle} 的独立模型开关和手动补充。`
        : '按模型聚合展示可见状态；客户端看到的是所有启用账号模型的去重合集。'}
      extra={isMobile ? (
        <div className="m-header-actions">
          {accountScoped ? (
            <MobileBackButton className="m-icon-btn" title="返回账号" onClick={() => navigate('/accounts')} />
          ) : null}
          {renderManualModelButton(true)}
          <button
            className="m-icon-btn primary"
            aria-label="刷新模型"
            disabled={loading || isCatalogJobActive(catalogJob)}
            onClick={refreshModels}
          >
            <ReloadOutlined spin={loading || isCatalogJobActive(catalogJob)} />
          </button>
        </div>
      ) : [
        accountScoped && (
          <Button key="back" icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
            返回账号
          </Button>
        ),
        renderManualModelButton(),
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          loading={loading || isCatalogJobActive(catalogJob)}
          onClick={refreshModels}
        >
          刷新模型
        </Button>
      ].filter(Boolean)}
    >
      {/* 顶部统计 —— 一条 KPI 条（StatisticCard.Group + 发丝线分隔） */}
      <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
        <StatisticCard statistic={{ title: '账号模型', value: metricSource.length }} />
        <StatisticCard statistic={{ title: accountScoped ? '启用模型' : '可见模型', value: visibleUnionCount }} />
        <StatisticCard statistic={{ title: '手动补充', value: manualCount }} />
      </StatisticCard.Group>

      {globalProbeError ? (() => {
        const probeError = parseUpstreamError(globalProbeError);
        return (
          <div className="models-probe-status" role="status">
            <span
              className={`hud-led ${catalog?.source === 'remote' ? 'hud-led--warn' : 'hud-led--err'}`}
              aria-hidden="true"
            />
            <Tag color={catalog?.source === 'remote' ? 'warning' : 'error'}>部分账号模型探测失败</Tag>
            {probeError.statusCode ? <Tag color="error">HTTP {probeError.statusCode}</Tag> : null}
            <span className="models-probe-status-message" title={probeError.message}>{probeError.message}</span>
            {probeError.url ? (
              <Typography.Link
                href={probeError.url}
                target="_blank"
                rel="noreferrer"
                className="models-probe-status-link"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(probeError.url).catch(() => message.error('无法打开外部链接'));
                }}
              >
                提交上游 issue ›
              </Typography.Link>
            ) : null}
            <Typography.Text
              type="secondary"
              copyable={{ text: probeError.raw, tooltips: ['复制原始错误', '已复制'] }}
              className="models-probe-status-copy"
            >
              原始错误
            </Typography.Text>
          </div>
        );
      })() : null}

      {catalogJob ? (
        <SectionCard
          className={`models-live-refresh models-live-refresh--${catalogJob.status} animate__animated animate__fadeIn animate__faster`}
        >
          <div className="models-live-refresh-grid">
            <div>
              <span className="hud-label">刷新状态</span>
              <strong>{formatCatalogJobStatus(catalogJob)}</strong>
            </div>
            <div>
              <span className="hud-label">探测范围</span>
              <strong>{formatCatalogProbeScope(catalogJob)}</strong>
            </div>
            <div>
              <span className="hud-label">可见模型</span>
              <strong>{getCatalogJobVisibleCount(catalogJob) ?? '-'}</strong>
            </div>
            <div>
              <span className="hud-label">探测账号</span>
              <strong>{catalogJob.catalog?.scannedAccounts ?? '-'}</strong>
            </div>
          </div>
          {catalogJob.error ? <p>{catalogJob.error}</p> : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title={accountScoped ? '当前账号模型' : '模型目录'}
        extra={(
          <Tag color={catalog?.cached ? 'default' : 'processing'}>
            {catalog?.cached ? '缓存' : '实时'}
          </Tag>
        )}
      >
        <p className="models-catalog-desc">
          {accountScoped
            ? `${scopedAccountTitle}，更新时间 ${formatUpdatedAt(catalog?.updatedAt)}。`
            : `端点 ${catalog?.endpoint || '/v1/models'}，当前可见模型 ${visibleUnionCount} 个。更新时间 ${formatUpdatedAt(catalog?.updatedAt)}。`}
        </p>

        {accountScoped ? (
          <div className="models-account-context">
            <div className="models-account-context-main">
              {scopedProvider ? <ProviderIcon provider={scopedProvider} size={20} /> : <ApiOutlined />}
              <div>
                <strong>{scopedAccountTitle}</strong>
              </div>
            </div>
            <div className="models-account-context-stats">
              <span>{metricSource.length} 个账号模型</span>
              <span>{visibleUnionCount} 个启用</span>
              <span>{manualCount} 个手动</span>
            </div>
          </div>
        ) : null}

        <DataToolbar
          filters={(
            <>
              {!accountScoped ? (
                <>
                  {/* Segmented 没有分组能力，所以这里保持"每个 Provider 一个 chip"，
                      靠 providerNames 的站点后缀（"Qoder · 国内站"）区分同族站点——
                      同族站点模型清单不同，筛选轴必须留在真实 Provider 上。 */}
                  <div className="models-provider-scroll">
                    <Segmented
                      value={providerFilter}
                      onChange={(value) => {
                        setProviderFilter(value as ProviderFilter);
                        setAccountFilter('all');
                      }}
                      options={[
                        { label: `全部 ${providerCounts.all || 0}`, value: 'all' },
                        ...MODEL_PROVIDERS.map((provider) => ({
                          label: `${providerNames[provider]} ${providerCounts[provider] || 0}`,
                          value: provider
                        }))
                      ]}
                    />
                  </div>
                  <Select
                    className="models-account-filter"
                    value={accountFilter}
                    onChange={(value) => setAccountFilter(value)}
                    options={[
                      { label: '全部账号', value: 'all' },
                      ...accountOptions
                        .filter((account) => providerFilter === 'all' || account.provider === providerFilter)
                        .map((account) => ({
                          label: (
                            <span className="models-account-option">
                              <ProviderIcon provider={account.provider} size={14} />
                              <span>{getAccountLabel(account)}</span>
                            </span>
                          ),
                          value: account.accountRef
                        }))
                    ]}
                  />
                </>
              ) : null}
              <Input.Search
                allowClear
                className="models-search"
                placeholder={accountScoped ? '搜索模型' : '搜索模型 ID'}
                value={keyword}
                onChange={(event) => {
                  const value = event.target.value;
                  setKeyword(value);
                }}
              />
              {isOpenCodeScoped ? (
                <Segmented
                  value={groupFilter}
                  onChange={(value) => setGroupFilter(value as ModelGroupFilter)}
                  options={[
                    { label: `全部分组 (${metricSource.length})`, value: 'all' },
                    { label: `Go 订阅 (${openCodeGoCount})`, value: 'go' },
                    { label: `Zen 按量 (${openCodeZenCount})`, value: 'zen' },
                    ...(openCodeFreeCount > 0 ? [{ label: `Free 免费 (${openCodeFreeCount})`, value: 'free' }] : [])
                  ]}
                />
              ) : null}
              <Segmented
                value={statusFilter}
                onChange={(value) => setStatusFilter(value as ModelStatusFilter)}
                options={MODEL_STATUS_FILTER_OPTIONS}
              />
            </>
          )}
        />

        {accountScoped ? (
          <PaginatedList<ManagedOpenAIModelItem>
            className="models-list models-list--account"
            items={accountModelRows}
            pageSize={16}
            emptyText="暂无数据"
            renderItem={(model) => renderModelRow(model)}
          />
        ) : (
          <PaginatedList<GlobalModelRow>
            className="models-list"
            items={globalRows}
            pageSize={14}
            emptyText="暂无数据"
            renderItem={(model) => renderGlobalModelRow(model)}
          />
        )}
      </SectionCard>

      <ModalForm
        title="手动添加模型"
        open={manualModalOpen}
        onOpenChange={setManualModalOpen}
        form={manualForm}
        layout="vertical"
        initialValues={{ provider: DEFAULT_MANUAL_MODEL_PROVIDER, enabled: true }}
        onFinish={submitManualModel}
        submitter={{
          searchConfig: {
            submitText: '添加',
            resetText: '取消',
          },
        }}
        modalProps={{
          destroyOnClose: true,
        }}
      >
        <div className="models-manual-form">
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select
              disabled={accountScoped}
              options={manualProviderOptions}
            />
          </Form.Item>
          <Form.Item
            name="accountRef"
            label="账号"
            rules={[{ required: true, message: '请选择账号' }]}
          >
            <Select disabled={accountScoped} options={manualAccountOptions} placeholder="选择账号" />
          </Form.Item>
          <Form.Item
            name="id"
            label="模型 ID"
            rules={[{ required: true, message: '请输入模型 ID' }]}
          >
            <Input placeholder="例如 gpt-5.6-sol-wm 或 provider-custom-model" autoFocus className="models-mono-input" />
          </Form.Item>
          <Form.Item name="description" label="备注">
            <Input placeholder="可选，用于区分手动补充来源" />
          </Form.Item>
          <Form.Item name="enabled" label="默认启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </div>
      </ModalForm>
    </PageScaffold>
  );
}
