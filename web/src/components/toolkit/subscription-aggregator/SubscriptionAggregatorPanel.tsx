import { useState } from 'react';
import { Empty, List, Popconfirm, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  ApartmentOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RetweetOutlined,
  SyncOutlined
} from '@ant-design/icons';
import { StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SectionCard from '@/components/ui/SectionCard';
import '@/components/ui/kpi-strip.css';
import { formatLastSynced } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import {
  countEnabledPresets,
  describeSourceScope,
  formatBytes,
  formatExpire,
  formatTraffic,
  maskSourceUrl
} from './aggregator-presentation';
import ProfileEditorDrawer from './ProfileEditorDrawer';
import ProfilePreviewModal from './ProfilePreviewModal';
import SourceEditorModal from './SourceEditorModal';
import SubscriptionLinkField from './SubscriptionLinkField';
import type { AggregatorProfile, AggregatorProfileInput, AggregatorSource } from './types';
import { useSubscriptionAggregator } from './use-subscription-aggregator';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

function totalTraffic(sources: AggregatorSource[]) {
  const withInfo = sources.filter((source) => source.userInfo?.total);
  if (!withInfo.length) return '—';
  const used = withInfo.reduce((sum, source) => sum + Number(source.userInfo?.upload || 0) + Number(source.userInfo?.download || 0), 0);
  const total = withInfo.reduce((sum, source) => sum + Number(source.userInfo?.total || 0), 0);
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

/** 订阅聚合与分流：管理订阅源，把它们聚合成带策略组与分流规则的单个订阅链接。 */
export default function SubscriptionAggregatorPanel() {
  const state = useSubscriptionAggregator();
  const { overview, loading, error, setError } = state;
  const [sourceEditor, setSourceEditor] = useState<{ source: AggregatorSource | null } | null>(null);
  const [editingProfile, setEditingProfile] = useState<AggregatorProfileInput | null>(null);
  const [previewProfile, setPreviewProfile] = useState<AggregatorProfile | null>(null);
  const sources = overview?.sources || [];
  const profiles = overview?.profiles || [];
  const totalNodes = sources.reduce((sum, source) => sum + source.nodeCount, 0) + (overview?.manualNodeCount || 0);

  const createProfile = () => {
    if (!overview) return;
    const template = overview.catalog.defaultProfile;
    setEditingProfile({ ...template, name: profiles.length ? `${template.name} ${profiles.length + 1}` : template.name });
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-aggregator-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">SUBSCRIPTION AGGREGATOR</div>
          <h2 id="toolkit-aggregator-title">订阅聚合与分流</h2>
          <p>把多个机场订阅合并成一个订阅链接：统一过滤、改名、按地区编组，并带上分流规则。Clash、sing-box、Shadowrocket 直接订阅即可。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void state.reload()}>重新读取</Button>
      </header>

      {error && (
        <InlineNote
          tone="error"
          description={error}
          className="toolkit-note-spaced"
          action={<Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭" onClick={() => setError('')} />}
        >
          订阅聚合操作未完成
        </InlineNote>
      )}

      {loading && !overview ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取订阅聚合配置" /></div>
      ) : overview ? (
        <>
          <div className="toolkit-stat-row">
            <StatisticCard.Group direction="row" bordered={false} className="hos-kpi-strip">
              <StatisticCard statistic={{ title: '订阅源', value: sources.length, icon: <LinkOutlined aria-hidden className="toolkit-kpi-icon" /> }} />
              <StatisticCard statistic={{ title: '节点', value: totalNodes, icon: <ApartmentOutlined aria-hidden className="toolkit-kpi-icon" /> }} />
              <StatisticCard statistic={{ title: '聚合订阅', value: profiles.length, icon: <RetweetOutlined aria-hidden className="toolkit-kpi-icon" /> }} />
              <StatisticCard statistic={{ title: '流量（已用 / 总量）', value: totalTraffic(sources), icon: <SyncOutlined aria-hidden className="toolkit-kpi-icon" /> }} />
            </StatisticCard.Group>
          </div>

          <SectionCard
            title="订阅源"
            className={styles.section}
            extra={(
              <Space wrap>
                <Button icon={<SyncOutlined />} loading={state.syncingAll} disabled={!sources.length} onClick={() => void state.syncAllSources()}>
                  全部同步
                </Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setSourceEditor({ source: null })}>添加订阅</Button>
              </Space>
            )}
          >
            <List
              dataSource={sources}
              locale={{ emptyText: <Empty description="还没有订阅源，先添加机场订阅地址（可批量粘贴）" /> }}
              renderItem={(source) => {
                const traffic = formatTraffic(source.userInfo);
                return (
                  <List.Item
                    actions={[
                      <Tooltip key="sync" title="立即拉取订阅">
                        <Button
                          size="small"
                          icon={<SyncOutlined />}
                          loading={state.syncingIds.has(source.id)}
                          aria-label={`同步 ${source.name}`}
                          onClick={() => void state.syncSource(source.id)}
                        />
                      </Tooltip>,
                      <Button key="edit" size="small" icon={<EditOutlined />} aria-label={`编辑 ${source.name}`} onClick={() => setSourceEditor({ source })} />,
                      <Popconfirm
                        key="delete"
                        title={`删除订阅源「${source.name}」？`}
                        description="它的节点会从节点库移除，绑定这些节点的 zcode 出口也会失效。"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void state.deleteSource(source.id)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} aria-label={`删除 ${source.name}`} />
                      </Popconfirm>
                    ]}
                  >
                    <List.Item.Meta
                      title={(
                        <Space size={8} wrap>
                          <span>{source.name}</span>
                          <Tag color="blue">{source.nodeCount} 个节点</Tag>
                          {traffic && <Tag>{traffic}</Tag>}
                          {source.userInfo?.total ? <Tag>到期 {formatExpire(source.userInfo.expire)}</Tag> : null}
                        </Space>
                      )}
                      description={(
                        <span className={styles.sourceMeta}>
                          <Text type="secondary" code className={styles.sourceUrl} title="订阅参数已隐藏">{maskSourceUrl(source.url)}</Text>
                          <Text type="secondary">上次同步：{formatLastSynced(source.lastSyncedAt)}</Text>
                        </span>
                      )}
                    />
                  </List.Item>
                );
              }}
            />
          </SectionCard>

          <SectionCard
            title="聚合订阅"
            className={styles.section}
            extra={<Button type="primary" icon={<PlusOutlined />} onClick={createProfile}>新建聚合</Button>}
          >
            <List
              dataSource={profiles}
              locale={{
                emptyText: (
                  <Empty description="还没有聚合订阅：新建一个，把上面的订阅源合并成一个链接">
                    <Button type="primary" icon={<PlusOutlined />} onClick={createProfile}>新建聚合订阅</Button>
                  </Empty>
                )
              }}
              renderItem={(profile) => (
                <List.Item className={styles.profileItem}>
                  <div className={styles.profileHead}>
                    <Space size={8} wrap>
                      <strong>{profile.name}</strong>
                      <Tag color="blue">{profile.nodeCount ?? 0} 个节点</Tag>
                      <Tag>{describeSourceScope(profile, sources.length)}</Tag>
                      <Tag>规则组 {countEnabledPresets(profile)}</Tag>
                      {profile.rules.custom.length > 0 && <Tag>自定义规则 {profile.rules.custom.length}</Tag>}
                      <Tag>{profile.refreshHours ? `每 ${profile.refreshHours} 小时自动刷新` : '仅手动同步'}</Tag>
                    </Space>
                    <Space size={4} wrap>
                      <Button size="small" icon={<EyeOutlined />} onClick={() => setPreviewProfile(profile)}>预览</Button>
                      <Button size="small" icon={<EditOutlined />} onClick={() => setEditingProfile(profile)}>编辑</Button>
                      <Popconfirm
                        title="重置订阅链接？"
                        description="旧链接立即失效，已订阅的客户端需要换成新链接。"
                        onConfirm={() => void state.rotateToken(profile.id)}
                      >
                        <Button size="small" icon={<RetweetOutlined />}>重置链接</Button>
                      </Popconfirm>
                      <Popconfirm
                        title={`删除聚合订阅「${profile.name}」？`}
                        description="订阅源和节点不受影响，只是这个链接失效。"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void state.deleteProfile(profile.id)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} aria-label={`删除 ${profile.name}`} />
                      </Popconfirm>
                    </Space>
                  </div>
                  <SubscriptionLinkField path={profile.subscriptionPath} name={profile.name} />
                </List.Item>
              )}
            />
          </SectionCard>

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
            onClose={() => setEditingProfile(null)}
            onSave={async (input) => Boolean(await state.saveProfile(input))}
          />
          <ProfilePreviewModal profile={previewProfile} onClose={() => setPreviewProfile(null)} />
        </>
      ) : null}
    </section>
  );
}
