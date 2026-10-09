import { useState } from 'react';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  RetweetOutlined,
  SyncOutlined
} from '@ant-design/icons';
import { formatLastSynced } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import {
  countEnabledPresets,
  describeSourceScope,
  formatExpire,
  formatTraffic
} from '@/components/toolkit/subscription-aggregator/aggregator-presentation';
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
import { ActionButton, InlineError, PanelToolbar, StatusText } from './toolkit-parts';

/** 订阅聚合与分流（移动端）：订阅源卡片列表 + 聚合订阅详情抽屉；编辑器与预览复用桌面组件（全宽）。 */
export default function SubscriptionAggregatorPanel() {
  const state = useSubscriptionAggregator();
  const { overview, loading, error, setError } = state;
  const [sourceEditor, setSourceEditor] = useState<{ source: AggregatorSource | null } | null>(null);
  const [editingProfile, setEditingProfile] = useState<AggregatorProfileInput | null>(null);
  const [previewProfile, setPreviewProfile] = useState<AggregatorProfile | null>(null);
  const [detailId, setDetailId] = useState('');

  if (loading && !overview) return <MobileBoot label="READING SUBSCRIPTIONS" />;

  const sources = overview?.sources || [];
  const profiles = overview?.profiles || [];
  const detail = profiles.find((profile) => profile.id === detailId) || null;
  const totalNodes = sources.reduce((sum, source) => sum + source.nodeCount, 0) + (overview?.manualNodeCount || 0);

  const createProfile = () => {
    if (!overview) return;
    const template = overview.catalog.defaultProfile;
    setEditingProfile({ ...template, name: profiles.length ? `${template.name} ${profiles.length + 1}` : template.name });
  };

  const confirmDeleteSource = async (source: AggregatorSource) => {
    const accepted = await confirmAction({
      title: `删除订阅源「${source.name}」？`,
      content: '它的节点会从节点库移除，绑定这些节点的 zcode 出口也会失效。',
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

          <HudSection
            title="订阅源"
            code="SOURCES"
            count={sources.length}
            extra={(
              <>
                <ActionButton icon={<SyncOutlined />} label="全部同步" loading={state.syncingAll} disabled={!sources.length} onClick={() => void state.syncAllSources()} />
                <ActionButton icon={<PlusOutlined />} label="添加" tone="primary" onClick={() => setSourceEditor({ source: null })} />
              </>
            )}
          >
            {sources.length ? (
              <MonoList ariaLabel="订阅源列表">
                {sources.map((source) => {
                  const traffic = formatTraffic(source.userInfo);
                  return (
                    <SwipeRow
                      key={source.id}
                      ariaLabel={`${source.name} 操作`}
                      onTap={() => setSourceEditor({ source })}
                      actions={[
                        { key: 'sync', label: '同步', icon: <SyncOutlined />, disabled: state.syncingIds.has(source.id), onAction: () => void state.syncSource(source.id) },
                        { key: 'delete', label: '删除', icon: <DeleteOutlined />, tone: 'danger', onAction: () => void confirmDeleteSource(source) }
                      ]}
                    >
                      <span className="mhud-row__main">
                        <span className="mhud-row__title">{source.name}</span>
                        <span className="mhud-row__meta">{traffic ? `${traffic} · 到期 ${formatExpire(source.userInfo?.expire)}` : `上次同步 ${formatLastSynced(source.lastSyncedAt)}`}</span>
                      </span>
                      <span className="mhud-row__side">
                        {state.syncingIds.has(source.id)
                          ? <StatusText tone="info" live>同步中</StatusText>
                          : <StatusText tone={source.nodeCount ? 'ok' : 'warn'}>{`${source.nodeCount} 节点`}</StatusText>}
                      </span>
                    </SwipeRow>
                  );
                })}
              </MonoList>
            ) : (
              <EmptySignal description="还没有订阅源，点「添加」可批量粘贴多个订阅地址" />
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
                <SubscriptionLinkField path={detail.subscriptionPath} name={detail.name} stacked />
                <KeyValue
                  rows={[
                    { key: 'nodes', label: '节点', value: `${detail.nodeCount ?? 0} 个` },
                    { key: 'scope', label: '订阅源', value: describeSourceScope(detail, sources.length) },
                    { key: 'presets', label: '规则组', value: `${countEnabledPresets(detail)} 个启用` },
                    { key: 'custom', label: '自定义规则', value: `${detail.rules.custom.length} 条` },
                    { key: 'refresh', label: '自动刷新', value: detail.refreshHours ? `每 ${detail.refreshHours} 小时` : '仅手动同步' }
                  ]}
                />
              </>
            ) : null}
          </DetailSheet>

          <SourceEditorModal
            open={Boolean(sourceEditor)}
            source={sourceEditor?.source || null}
            onClose={() => setSourceEditor(null)}
            onSave={state.saveSource}
            onSaveBatch={state.saveSources}
          />
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
          <ProfilePreviewModal profile={previewProfile} width="100%" onClose={() => setPreviewProfile(null)} />
        </>
      ) : null}
    </>
  );
}
