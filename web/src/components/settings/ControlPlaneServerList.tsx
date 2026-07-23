import type { ReactNode } from 'react';
import { Card, Dropdown, Space } from 'antd';
import { DeleteOutlined, MoreOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { isControlPlaneManagementKeyConfigured } from '@/services/control-plane-profiles';
import type { ControlPlaneProfile, ControlPlaneProfileState } from '@/types';
import type { ServerRouteRow, ServerRouteView } from '@/services/server-route-presentation';
import './ControlPlaneServerList.css';

type StatusTone = 'ready' | 'degraded' | 'offline';

const CONTROL_PLANE_PROFILE_STATUS: Record<ControlPlaneProfileState, { tone: StatusTone; label: string }> = {
  ready: { tone: 'ready', label: '就绪' },
  degraded: { tone: 'degraded', label: '连接异常' },
  offline: { tone: 'offline', label: '离线' }
};

const getControlPlaneProfileStatus = (state: ControlPlaneProfileState) => (
  CONTROL_PLANE_PROFILE_STATUS[state] || CONTROL_PLANE_PROFILE_STATUS.offline
);

interface ControlPlaneServerListProps {
  rows: ServerRouteRow[];
  activeControlPlaneId: string;
  checkingControlPlaneId: string;
  onSelect: (profileId: string) => void;
  onRefresh: (profile: ControlPlaneProfile) => void;
  onRemove: (profileId: string) => void;
  onAuthorize: (profile: ControlPlaneProfile) => void;
}

function buildMetricsNodes(profile: ControlPlaneProfile): ReactNode[] {
  const syncUnavailable = profile.state === 'degraded' || Boolean(profile.lastError);
  const cachedSummary = [
    profile.lastStatusSyncAt > 0 ? `账号 ${profile.accountCount}` : '',
    profile.lastSessionsSyncAt > 0 ? `会话 ${profile.sessionCount}` : ''
  ].filter(Boolean).join(' · ');

  if (syncUnavailable) {
    return [
      <span key="unavailable" className="cp-footer-pending">
        数据无法获取
        {cachedSummary && <> · 上次缓存：{cachedSummary}</>}
      </span>
    ];
  }

  return [
    profile.lastStatusSyncAt > 0 && (
      <span key="accounts">
        账号 <b>{profile.activeAccountCount}/{profile.accountCount}</b>
        {profile.lastAccountsSyncAt > 0 && profile.schedulableAccountCount > 0
          ? `（${profile.schedulableAccountCount} 可调度）`
          : ''}
      </span>
    ),
    profile.lastSessionsSyncAt > 0 && (
      <span key="sessions">会话 <b>{profile.sessionCount}</b></span>
    )
  ].filter(Boolean);
}

function RouteChip({ route }: { route: ServerRouteView }) {
  return (
    <span
      className={`cp-route-chip cp-route-chip--health-${route.healthColor}${route.primary ? ' cp-route-chip--primary' : ''}`}
      title={route.endpoint}
    >
      <span className={`cp-route-dot cp-route-dot--${route.healthColor}`} aria-hidden="true" />
      <span className="cp-route-kind">{route.kindLabel}</span>
      <span className="cp-route-endpoint">{route.endpointLabel}</span>
      <span className="cp-route-rtt">{route.rttLabel}</span>
    </span>
  );
}

function ServerCardActions({
  row,
  active,
  checking,
  onSelect,
  onRefresh,
  onRemove,
  onAuthorize
}: {
  row: ServerRouteRow;
  active: boolean;
  checking: boolean;
  onSelect: (profileId: string) => void;
  onRefresh: (profile: ControlPlaneProfile) => void;
  onRemove: (profileId: string) => void;
  onAuthorize: (profile: ControlPlaneProfile) => void;
}) {
  const { profile, authorizationPending } = row;
  return (
    <Space size={6} wrap>
      {authorizationPending ? (
        <Button size="small" type="primary" onClick={() => onAuthorize(profile)}>
          授权
        </Button>
      ) : (
        <>
          {active ? (
            <span className="cp-current-badge">当前</span>
          ) : (
            <Button size="small" onClick={() => onSelect(profile.id)}>设为当前</Button>
          )}
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={checking}
            onClick={() => onRefresh(profile)}
            aria-label="同步"
          />
        </>
      )}
      <Dropdown
        trigger={['click']}
        menu={{
          items: [{ key: 'remove', danger: true, label: '移除', icon: <DeleteOutlined /> }],
          onClick: ({ key }) => {
            if (key === 'remove') onRemove(profile.id);
          }
        }}
      >
        <Button size="small" icon={<MoreOutlined />} aria-label="更多操作" />
      </Dropdown>
    </Space>
  );
}

export default function ControlPlaneServerList({
  rows,
  activeControlPlaneId,
  checkingControlPlaneId,
  onSelect,
  onRefresh,
  onRemove,
  onAuthorize
}: ControlPlaneServerListProps) {
  return (
    <div className="cp-server-list">
      {rows.map((row) => {
        const { profile, authorizationPending } = row;
        const active = activeControlPlaneId === profile.id;
        const status = getControlPlaneProfileStatus(profile.state);
        const name = profile.name || profile.endpoint;
        return (
          <Card
            key={row.stableServerId}
            size="small"
            bordered={false}
            className={`cp-server-card${active ? ' cp-server-card--active' : ''}`}
          >
            <div className="cp-server-card-head">
              <div className="cp-server-card-title">
                <Space size={6} wrap>
                  {authorizationPending ? (
                    <span className="cp-status-pill cp-status-pill--pending">已发现，待授权</span>
                  ) : (
                    <span className={`cp-status-pill cp-status-pill--${status.tone}`}>{status.label}</span>
                  )}
                  <span className="cp-server-card-name" title={name}>{name}</span>
                  {!authorizationPending && isControlPlaneManagementKeyConfigured(profile) && (
                    <span className="cp-key-configured">Key 已配置</span>
                  )}
                </Space>
                <div className="cp-server-meta">
                  <span>{row.stableServerId}</span>
                  {profile.lastError && <span className="cp-server-error">{profile.lastError}</span>}
                </div>
              </div>
              <div className="cp-server-card-actions">
                <ServerCardActions
                  row={row}
                  active={active}
                  checking={checkingControlPlaneId === profile.id}
                  onSelect={onSelect}
                  onRefresh={onRefresh}
                  onRemove={onRemove}
                  onAuthorize={onAuthorize}
                />
              </div>
            </div>

            {row.routes.length > 0 && (
              <div className="cp-route-row">
                {row.routes.map((route) => <RouteChip key={route.id} route={route} />)}
              </div>
            )}

            <div className="cp-server-card-footer">
              {authorizationPending ? (
                <span className="cp-footer-pending">输入 Management Key 后即可连接</span>
              ) : (
                buildMetricsNodes(profile)
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
