import { useState } from 'react';
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  FormOutlined,
  GatewayOutlined,
  ImportOutlined,
  PlusOutlined,
  PoweroffOutlined,
  RetweetOutlined,
  SyncOutlined,
  UnorderedListOutlined
} from '@ant-design/icons';
import { formatLastSynced } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import {
  aggregatorErrorText,
  countEnabledPresets,
  describePull,
  describeSourceOrigin,
  describeSourceScope,
  formatExpire,
  formatPullTime,
  formatTraffic,
  policyLabel
} from '@/components/toolkit/subscription-aggregator/aggregator-presentation';
import ImportProfileModal from '@/components/toolkit/subscription-aggregator/ImportProfileModal';
import ManualNodeModal from '@/components/toolkit/subscription-aggregator/ManualNodeModal';
import { manualNodeSaveInput } from '@/components/toolkit/subscription-aggregator/manual-nodes';
import SourceNodesDrawer from '@/components/toolkit/subscription-aggregator/SourceNodesDrawer';
import ProfileEditorDrawer from '@/components/toolkit/subscription-aggregator/ProfileEditorDrawer';
import ProfilePreviewModal from '@/components/toolkit/subscription-aggregator/ProfilePreviewModal';
import SourceEditorModal from '@/components/toolkit/subscription-aggregator/SourceEditorModal';
import SubscriptionLinkField from '@/components/toolkit/subscription-aggregator/SubscriptionLinkField';
import type {
  AggregatorProfile,
  AggregatorProfileInput,
  AggregatorSource
} from '@/components/toolkit/subscription-aggregator/types';
import { useSubscriptionAggregator } from '@/components/toolkit/subscription-aggregator/use-subscription-aggregator';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudSection, KeyValue, MonoList, SwipeRow, TelemetryGrid, TelemetryTile } from '@/mobile/ui';
import { confirmAction } from '@/utils/confirm-action';
import { ActionButton, InlineError, Note, PanelToolbar, StatusText } from './toolkit-parts';
import EdgeForwardingPanel from './EdgeForwardingPanel';

// 手机屏幕小：订阅源列表先显示这么多，其余按需展开。
const MOBILE_SOURCE_PAGE_SIZE = 12;

/** 订阅聚合与分流（移动端）：订阅源卡片列表 + 聚合订阅详情抽屉；编辑器与预览复用桌面组件（全宽）。 */
export default function SubscriptionAggregatorPanel() {
  const state = useSubscriptionAggregator();
  const { overview, loading, error, setError } = state;
  const [sourceEditor, setSourceEditor] = useState<{ source: AggregatorSource | null } | null>(null);
  const [editingProfile, setEditingProfile] = useState<AggregatorProfileInput | null>(null);
  const [previewProfile, setPreviewProfile] = useState<AggregatorProfile | null>(null);
  const [importProfile, setImportProfile] = useState<AggregatorProfile | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [detailId, setDetailId] = useState('');
  const [nodesSourceId, setNodesSourceId] = useState('');
  const [addingNode, setAddingNode] = useState(false);
  // 手机上几十个订阅源一次渲染太长，分批展开。
  const [sourceLimit, setSourceLimit] = useState(MOBILE_SOURCE_PAGE_SIZE);

  if (loading && !overview) return <MobileBoot label="READING SUBSCRIPTIONS" />;

  const sources = overview?.sources || [];
  const profiles = overview?.profiles || [];
  const detail = profiles.find((profile) => profile.id === detailId) || null;
  const totalNodes = sources.reduce((sum, source) => sum + source.nodeCount, 0) + (overview?.manualNodeCount || 0);
  const enabledSources = sources.filter((source) => source.enabled);
  const visibleSources = sources.slice(0, sourceLimit);

  const createProfile = () => {
    if (!overview) return;
    const template = overview.catalog.defaultProfile;
    setEditingProfile({ ...template, name: profiles.length ? `${template.name} ${profiles.length + 1}` : template.name });
  };

  const confirmDeleteSource = async (source: AggregatorSource) => {
    const accepted = await confirmAction({
      title: `删除订阅源「${source.name}」？`,
      content: '它的节点会从节点库移除，聚合订阅里也不再包含这些节点。',
      okText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (accepted) await state.deleteSource(source.id);
  };

  const confirmRotate = async (profile: AggregatorProfile) => {
    const accepted = await confirmAction({
      title: '重置订阅链接？',
      content: '旧链接立即失效，已订阅的客户端需要换成新链接。',
      okText: '重置',
      cancelText: '取消'
    });
    if (accepted) await state.rotateToken(profile.id);
  };

  const confirmDeleteProfile = async (profile: AggregatorProfile) => {
    const accepted = await confirmAction({
      title: `删除聚合订阅「${profile.name}」？`,
      content: '订阅源和节点不受影响，只是这个链接失效。',
      okText: '删除',
      cancelText: '取消',
      danger: true
    });
    if (!accepted) return;
    setDetailId('');
    await state.deleteProfile(profile.id);
  };

  return (
    <>
      <PanelToolbar status="多个订阅合成一个链接，附带分流规则" refreshLabel="重新读取" refreshing={loading} onRefresh={() => void state.reload()} />
      {error ? <InlineError title="订阅聚合操作未完成" detail={error} onDismiss={() => setError('')} /> : null}

      {overview ? (
        <>
          <TelemetryGrid>
            <TelemetryTile label="订阅源" value={sources.length} tone="info" />
            <TelemetryTile label="节点" value={totalNodes} tone="info" />
            <TelemetryTile label="聚合订阅" value={profiles.length} tone={profiles.length ? 'ok' : 'muted'} />
          </TelemetryGrid>

          <HudSection
            title="聚合订阅"
            code="AGGREGATE"
            count={profiles.length}
            extra={<ActionButton icon={<PlusOutlined />} label="新建" tone="primary" onClick={createProfile} />}
          >
            {profiles.length ? (
              <MonoList ariaLabel="聚合订阅列表">
                {profiles.map((profile) => (
                  <SwipeRow
                    key={profile.id}
                    onTap={() => setDetailId(profile.id)}
                    ariaLabel={`${profile.name} 详情`}
                    actions={[
                      { key: 'preview', label: '预览', icon: <EyeOutlined />, onAction: () => setPreviewProfile(profile) },
                      { key: 'edit', label: '编辑', icon: <EditOutlined />, tone: 'primary', onAction: () => setEditingProfile(profile) }
                    ]}
                  >
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{profile.name}</span>
                      <span className="mhud-row__meta">{describeSourceScope(profile, sources.length)}</span>
                    </span>
                    <span className="mhud-row__side">
                      <StatusText tone="ok">{`${profile.nodeCount ?? 0} 节点`}</StatusText>
                    </span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="还没有聚合订阅，新建一个把订阅源合并成一个链接" />
            )}
          </HudSection>

          <HudSection title="客户端入口" code="ENTRY">
            <Note tone="info">
              中转条目写的是 <code>socks5, &lt;地址&gt;, &lt;端口&gt;</code>：想把入口放到 443 / 域名 / VPS 上，
              先用 nginx 或 caddy 生成一次计划；这里只生成，写入在「应用与集成 → 入口与转发」。
            </Note>
            <ActionButton icon={<GatewayOutlined />} label="生成一次计划" onClick={() => setEntryOpen(true)} />
          </HudSection>

          <HudSection
            title="订阅源"
            code="SOURCES"
            count={sources.length}
            extra={(
              <>
                <ActionButton
                  icon={<SyncOutlined />}
                  label={state.syncingAll ? '同步中' : '全部同步'}
                  loading={state.syncingAll}
                  disabled={!enabledSources.length || state.syncingAll}
                  onClick={() => state.syncAllSources(enabledSources.map((source) => source.id))}
                />
                <ActionButton icon={<FormOutlined />} label="加节点" onClick={() => setAddingNode(true)} />
                <ActionButton icon={<PlusOutlined />} label="添加" tone="primary" onClick={() => setSourceEditor({ source: null })} />
              </>
            )}
          >
            {sources.length ? (
              <>
                <MonoList ariaLabel="订阅源列表">
                  {visibleSources.map((source) => {
                    const traffic = formatTraffic(source.userInfo);
                    const syncing = state.syncingIds.has(source.id);
                    const last = state.lastResultFor(source.id);
                    return (
                      <SwipeRow
                        key={source.id}
                        ariaLabel={`${source.name} 操作`}
                        onTap={() => setSourceEditor({ source })}
                        actions={[
                          { key: 'toggle', label: source.enabled ? '停用' : '启用', icon: <PoweroffOutlined />, disabled: syncing, onAction: () => void state.setSourceEnabled(source.id, !source.enabled) },
                          { key: 'nodes', label: '节点', icon: <UnorderedListOutlined />, onAction: () => setNodesSourceId(source.id) },
                          { key: 'sync', label: '同步', icon: <SyncOutlined />, disabled: syncing || !source.enabled, onAction: () => state.syncSource(source.id) },
                          { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => void confirmDeleteSource(source) }
                        ]}
                      >
                        <span className="mhud-row__main">
                          <span className="mhud-row__title">{source.enabled ? source.name : `${source.name}（已停用）`}</span>
                          <span className="mhud-row__meta">
                            {source.kind === 'local'
                              ? describeSourceOrigin(source)
                              : traffic ? `${traffic} · 到期 ${formatExpire(source.userInfo?.expire)}` : `上次同步 ${formatLastSynced(source.lastSyncedAt)}`}
                            {!syncing && last?.state === 'failed' ? ` · 上次失败：${aggregatorErrorText(last.error, '同步失败')}` : ''}
                          </span>
                        </span>
                        <span className="mhud-row__side">
                          {syncing
                            ? <StatusText tone="info" live>同步中</StatusText>
                            : source.enabled
                              ? <StatusText tone={source.nodeCount ? 'ok' : 'warn'}>{`${source.nodeCount} 节点`}</StatusText>
                              : <StatusText tone="muted">已停用</StatusText>}
                        </span>
                      </SwipeRow>
                    );
                  })}
                </MonoList>
                {sources.length > MOBILE_SOURCE_PAGE_SIZE && (
                  <ActionButton
                    icon={<DownOutlined />}
                    label={visibleSources.length < sources.length
                      ? `显示更多（还有 ${sources.length - visibleSources.length} 个）`
                      : '收起'}
                    onClick={() => setSourceLimit((current) => (current >= sources.length ? MOBILE_SOURCE_PAGE_SIZE : current + MOBILE_SOURCE_PAGE_SIZE))}
                  />
                )}
              </>
            ) : (
              <EmptySignal description="还没有订阅源，点「添加」填订阅地址（可批量）、扫描本机，或粘贴自建节点" />
            )}
          </HudSection>

          <DetailSheet
            open={Boolean(detail)}
            onClose={() => setDetailId('')}
            code="AGGREGATE // LINK"
            title={detail?.name || '聚合订阅'}
            footer={detail ? (
              <>
                <ActionButton icon={<EyeOutlined />} label="预览" onClick={() => setPreviewProfile(detail)} />
                <ActionButton icon={<EditOutlined />} label="编辑" tone="primary" onClick={() => setEditingProfile(detail)} />
                <ActionButton icon={<RetweetOutlined />} label="重置链接" onClick={() => void confirmRotate(detail)} />
                <ActionButton icon={<DeleteOutlined />} label="删除" tone="danger" onClick={() => void confirmDeleteProfile(detail)} />
              </>
            ) : null}
          >
            {detail ? (
              <>
                <SubscriptionLinkField
                  path={detail.subscriptionPath}
                  name={detail.name}
                  formats={overview.catalog.formats}
                  clients={overview.catalog.clients}
                  stacked
                />
                <ActionButton icon={<ImportOutlined />} label="导入到客户端 / 扫码" tone="primary" onClick={() => setImportProfile(detail)} />
                <KeyValue
                  rows={[
                    { key: 'nodes', label: '节点', value: `${detail.nodeCount ?? 0} 个` },
                    { key: 'scope', label: '订阅源', value: describeSourceScope(detail, sources.length) },
                    { key: 'presets', label: '规则组', value: `${countEnabledPresets(detail)} 个启用` },
                    { key: 'custom', label: '自定义规则', value: `${detail.rules.custom.length} 条` },
                    { key: 'refresh', label: '自动刷新', value: detail.refreshHours ? `每 ${detail.refreshHours} 小时` : '仅手动同步' },
                    {
                      key: 'pulls',
                      label: '最近拉取',
                      value: detail.recentPulls?.length
                        ? `${describePull(detail.recentPulls[0], overview.catalog.formats)} · ${formatPullTime(detail.recentPulls[0].at)}`
                        : '还没有客户端拉取过'
                    }
                  ]}
                />
              </>
            ) : null}
          </DetailSheet>

          <SourceEditorModal
            open={Boolean(sourceEditor)}
            source={sourceEditor?.source || null}
            defaultUserAgent={overview.catalog.defaultUserAgent}
            onClose={() => setSourceEditor(null)}
            onSave={state.saveSource}
            onSaveBatch={state.saveSources}
            onScanLocal={state.scanLocalSources}
            onImportLocal={state.importLocalSources}
            scanning={state.scanning}
          />
          <DetailSheet
            open={entryOpen}
            onClose={() => setEntryOpen(false)}
            title="用 nginx / caddy 生成一次计划"
            code="ENTRY"
          >
            <EdgeForwardingPanel planOnly />
          </DetailSheet>
          <ProfileEditorDrawer
            open={Boolean(editingProfile)}
            profile={editingProfile}
            catalog={overview.catalog}
            sources={sources}
            manualNodeCount={overview.manualNodeCount}
            width="100%"
            onClose={() => setEditingProfile(null)}
            onSave={async (input) => Boolean(await state.saveProfile(input))}
          />
          <ProfilePreviewModal
            profile={previewProfile}
            formats={overview.catalog.formats}
            clients={overview.catalog.clients}
            describePolicy={(policy) => policyLabel(policy, { catalog: overview.catalog, sources, groups: previewProfile?.groups.custom })}
            width="100%"
            onClose={() => setPreviewProfile(null)}
          />
          <ImportProfileModal
            profile={importProfile}
            formats={overview.catalog.formats}
            width="100%"
            defaultTab="mobile"
            onClose={() => setImportProfile(null)}
          />
          <SourceNodesDrawer
            source={sources.find((source) => source.id === nodesSourceId) || null}
            forms={overview.catalog.protocolForms || []}
            width="100%"
            onClose={() => setNodesSourceId('')}
            onSaveSource={state.saveSource}
          />
          <ManualNodeModal
            open={addingNode}
            title="手动添加节点"
            forms={overview.catalog.protocolForms || []}
            initial={null}
            width="100%"
            onClose={() => setAddingNode(false)}
            onSubmit={(node) => state.saveSource(manualNodeSaveInput(sources, node))}
          />
        </>
      ) : null}
    </>
  );
}
