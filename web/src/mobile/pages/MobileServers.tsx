import { useMemo, useState } from 'react';
import { Button, Form, Input } from 'antd';
import {
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExportOutlined,
  KeyOutlined,
  LinkOutlined,
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  StarOutlined
} from '@ant-design/icons';
import {
  DetailSheet,
  EmptySignal,
  HudCard,
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
import type { HudTone, SwipeAction } from '@/mobile/ui';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  useControlPlaneServers,
  type ControlPlaneServerFormValues
} from '@/components/control-plane/use-control-plane-servers';
import {
  SERVER_PENDING_AUTH_LABEL,
  getControlPlaneProfileStatus,
  summarizeControlPlaneServerMetrics
} from '@/components/control-plane/server-list-presentation';
import { isControlPlaneManagementKeyConfigured } from '@/services/control-plane-profiles';
import { formatEndpointHintLabel } from '@/services/control-plane-endpoints';
import { buildServerScopedAppHref } from '@/services/app-navigation';
import type { ServerRouteRow } from '@/services/server-route-presentation';
import type { ControlPlaneProfile } from '@/types';
import { confirmAction } from '@/utils/confirm-action';
import FabricFormItem from './fabric/FabricFormItem';
import fabric from './fabric/fabric.module.css';
import styles from './MobileServers.module.css';

const STATUS_TONE: Record<string, HudTone> = { ready: 'ok', degraded: 'warn', offline: 'muted' };
const ROUTE_HEALTH_TONE: Record<string, HudTone> = { green: 'ok', orange: 'warn', red: 'err', default: 'muted' };

function rowStatus(row: ServerRouteRow): { tone: HudTone; label: string } {
  if (row.authorizationPending) return { tone: 'info', label: '待授权' };
  const status = getControlPlaneProfileStatus(row.profile.state);
  return { tone: STATUS_TONE[status.tone] || 'muted', label: status.label };
}

function StatusText({ tone, label }: { tone: HudTone; label: string }) {
  return (
    <span className={`mhud-status mhud-tone--${tone}`}>
      <span className={`hud-led hud-led--${tone === 'muted' ? 'info' : tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** 与桌面卡片页脚一致的指标文案：账号 active/total（N 可调度）· 会话 N；异常时只给上次缓存。 */
function metricsText(profile: ControlPlaneProfile) {
  const metrics = summarizeControlPlaneServerMetrics(profile);
  if (metrics.unavailable) {
    return metrics.cachedSummary ? `数据无法获取 · 上次缓存：${metrics.cachedSummary}` : '数据无法获取';
  }
  return [
    metrics.accounts
      ? `账号 ${metrics.accounts.active}/${metrics.accounts.total}${metrics.accounts.schedulable > 0 ? `（${metrics.accounts.schedulable} 可调度）` : ''}`
      : '',
    metrics.sessions !== null ? `会话 ${metrics.sessions}` : ''
  ].filter(Boolean).join(' · ');
}

type ServerFormSeed = { authorizingProfileId: string; values: ControlPlaneServerFormValues; version: number };

/**
 * /fabric/servers 移动端：默认 Server 遥测卡 + 逻辑 Server 列表（左滑：设为默认 / 同步 / 移除，
 * 待授权行：授权 / 移除）+ 详情抽屉（路径、指标、操作）+ 添加 / 授权表单抽屉。
 * 数据与操作全部来自 useControlPlaneServers（与桌面 Server 管理分区同一套 service 调用）。
 */
export default function MobileServers(_props: MobilePageProps) {
  const servers = useControlPlaneServers();
  const {
    serverRouteRows,
    overview,
    activeControlPlaneId,
    activeProfile,
    checkingControlPlaneId
  } = servers;
  const [form] = Form.useForm<ControlPlaneServerFormValues>();
  const [detailId, setDetailId] = useState('');
  const [formSeed, setFormSeed] = useState<ServerFormSeed | null>(null);

  const detailRow = useMemo(
    () => serverRouteRows.find((row) => row.profile.id === detailId) || null,
    [serverRouteRows, detailId]
  );

  const openAddServer = () => {
    setFormSeed((prev) => ({
      authorizingProfileId: '',
      values: { endpoint: servers.defaultEndpoint, name: 'AIH Server', managementKey: '' },
      version: (prev?.version || 0) + 1
    }));
  };

  const openAuthorization = (profile: ControlPlaneProfile) => {
    setDetailId('');
    setFormSeed((prev) => ({
      authorizingProfileId: profile.id,
      values: { endpoint: profile.endpoint, name: profile.name, managementKey: '' },
      version: (prev?.version || 0) + 1
    }));
  };

  const closeForm = () => setFormSeed(null);

  const handleSubmit = async (values: ControlPlaneServerFormValues) => {
    if (!formSeed) return;
    const saved = await servers.saveControlPlane(formSeed.authorizingProfileId, values);
    if (saved) closeForm();
  };

  const handleRemove = async (profile: ControlPlaneProfile) => {
    const confirmed = await confirmAction({
      title: '移除 Server',
      content: `从本机移除「${profile.name || profile.endpoint}」的连接配置？`,
      okText: '移除',
      danger: true
    });
    if (!confirmed) return;
    if (detailId === profile.id) setDetailId('');
    await servers.removeControlPlane(profile.id);
  };

  const rowActions = (row: ServerRouteRow): SwipeAction[] => {
    const { profile } = row;
    const remove: SwipeAction = {
      key: 'remove',
      label: '移除',
      icon: <DeleteOutlined />,
      tone: 'danger',
      onAction: () => handleRemove(profile)
    };
    if (row.authorizationPending) {
      return [
        { key: 'authorize', label: '授权', icon: <KeyOutlined />, tone: 'primary', onAction: () => openAuthorization(profile) },
        remove
      ];
    }
    return [
      {
        key: 'select',
        label: '设为默认',
        icon: <StarOutlined />,
        tone: 'primary',
        disabled: profile.id === activeControlPlaneId,
        onAction: () => servers.selectControlPlane(profile.id)
      },
      {
        key: 'refresh',
        label: '同步',
        icon: <ReloadOutlined />,
        disabled: checkingControlPlaneId === profile.id,
        onAction: () => servers.refreshControlPlane(profile)
      },
      remove
    ];
  };

  const activeRow = serverRouteRows.find((row) => row.profile.id === activeControlPlaneId) || null;
  const activeStatus = activeRow ? rowStatus(activeRow) : null;

  const toolbar = (
    <MobileToolbar
      start={<span className={`${fabric.mono} ${styles.toolbarCount}`}>{serverRouteRows.length} SERVER</span>}
    >
      {servers.canDiscoverLan ? (
        <HudIconButton
          icon={<RadarChartOutlined />}
          label="发现局域网 Server"
          loading={servers.discoveringLanServers}
          onClick={servers.discoverLanServers}
        />
      ) : null}
      <HudIconButton
        icon={<ReloadOutlined />}
        label="同步全部"
        disabled={servers.refreshableCount === 0}
        loading={servers.refreshingAll}
        onClick={servers.refreshAllControlPlanes}
      />
      <HudIconButton icon={<PlusOutlined />} label="添加 Server" tone="primary" showLabel onClick={openAddServer} />
    </MobileToolbar>
  );

  return (
    <MobilePage
      toolbar={toolbar}
      lead="默认 Server 用于无参数页面；点击“打开”会用显式 server 参数固定当前标签页，可同时操作多台 Server。"
    >
      <HudCard
        code="DEFAULT"
        title="默认 Server"
        tone={activeStatus?.tone}
        active={Boolean(activeProfile)}
        extra={activeStatus ? <StatusText tone={activeStatus.tone} label={activeStatus.label} /> : null}
      >
        <div className={styles.current}>
          <strong className={styles.currentName}>
            {activeProfile ? activeProfile.name || activeProfile.endpoint || activeProfile.id : '未选择服务器'}
          </strong>
          <div className={fabric.endpoint}>
            <code>{activeProfile ? activeProfile.endpoint : '请先添加 Server'}</code>
            {activeProfile?.endpoint ? (
              <HudIconButton
                icon={<CopyOutlined />}
                label="复制 Server URL"
                onClick={() => servers.copyEndpoint(activeProfile.endpoint)}
              />
            ) : null}
          </div>
          {activeProfile?.lastError ? <p className={fabric.noteErr}>{activeProfile.lastError}</p> : null}
        </div>
        <Button
          block
          icon={<ReloadOutlined />}
          disabled={!activeProfile}
          loading={Boolean(activeProfile) && checkingControlPlaneId === activeProfile?.id}
          onClick={() => activeProfile && servers.refreshControlPlane(activeProfile)}
        >
          同步当前
        </Button>
      </HudCard>

      <TelemetryGrid>
        <TelemetryTile label="服务器" value={overview.total} tone="info" />
        <TelemetryTile label="可调度账号" value={overview.schedulableAccounts} tone={overview.schedulableAccounts > 0 ? 'ok' : 'muted'} />
        <TelemetryTile label="会话" value={overview.sessions} tone="info" wide />
      </TelemetryGrid>

      <HudSection title="Server" code="NODES" count={serverRouteRows.length}>
        {serverRouteRows.length === 0 ? (
          <EmptySignal
            title="NO SERVER"
            description="暂无已保存 Server"
            action={(
              <Button type="primary" icon={<PlusOutlined />} onClick={openAddServer}>
                添加 Server
              </Button>
            )}
          />
        ) : (
          <MonoList ariaLabel="已保存 Server">
            {serverRouteRows.map((row) => {
              const { profile } = row;
              const status = rowStatus(row);
              const active = profile.id === activeControlPlaneId;
              const name = profile.name || profile.endpoint;
              return (
                <SwipeRow
                  key={row.stableServerId}
                  actions={rowActions(row)}
                  onTap={() => setDetailId(profile.id)}
                  ariaLabel={`${name}，${status.label}${active ? '，默认' : ''}`}
                >
                  <span className={`mhud-row__icon mhud-tone--${status.tone}`} aria-hidden="true">
                    <CloudServerOutlined />
                  </span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{name}</span>
                    <span className="mhud-row__meta">{profile.endpoint}</span>
                    <span className="mhud-row__meta">
                      {row.authorizationPending ? '输入 Management Key 后即可连接' : metricsText(profile) || '尚未同步'}
                    </span>
                  </span>
                  <span className="mhud-row__side">
                    <StatusText tone={status.tone} label={status.label} />
                    {active ? <span className={fabric.badge}>默认</span> : null}
                    {checkingControlPlaneId === profile.id ? <span className="mhud-tone--info">SYNC…</span> : null}
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
      </HudSection>

      <DetailSheet
        open={Boolean(detailRow)}
        onClose={() => setDetailId('')}
        code="SERVER"
        title={detailRow ? detailRow.profile.name || detailRow.profile.endpoint : ''}
        footer={detailRow ? (
          detailRow.authorizationPending ? (
            <>
              <Button danger icon={<DeleteOutlined />} onClick={() => handleRemove(detailRow.profile)}>移除</Button>
              <Button type="primary" icon={<KeyOutlined />} onClick={() => openAuthorization(detailRow.profile)}>授权</Button>
            </>
          ) : (
            <>
              <Button
                icon={<ReloadOutlined />}
                loading={checkingControlPlaneId === detailRow.profile.id}
                onClick={() => servers.refreshControlPlane(detailRow.profile)}
              >
                同步
              </Button>
              <Button
                type="primary"
                icon={<StarOutlined />}
                disabled={detailRow.profile.id === activeControlPlaneId}
                onClick={() => servers.selectControlPlane(detailRow.profile.id)}
              >
                {detailRow.profile.id === activeControlPlaneId ? '已是默认' : '设为默认'}
              </Button>
            </>
          )
        ) : null}
      >
        {detailRow ? (
          <ServerDetail
            row={detailRow}
            onCopy={servers.copyEndpoint}
            onRemove={() => handleRemove(detailRow.profile)}
          />
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={Boolean(formSeed)}
        onClose={closeForm}
        code={formSeed?.authorizingProfileId ? 'AUTHORIZE' : 'ADD'}
        title={formSeed?.authorizingProfileId ? '授权 Server' : '添加 Server'}
        maxHeight="92dvh"
        footer={(
          <Button
            type="primary"
            icon={<LinkOutlined />}
            loading={servers.saving}
            onClick={() => form.submit()}
          >
            {formSeed?.authorizingProfileId ? '授权并连接' : '探测并保存'}
          </Button>
        )}
      >
        {formSeed ? (
          <Form
            key={formSeed.version}
            form={form}
            layout="vertical"
            className={fabric.form}
            initialValues={formSeed.values}
            clearOnDestroy
            onFinish={handleSubmit}
          >
            <FabricFormItem
              name="endpoint"
              label="Server URL"
              required
              hint="支持 HTTPS、Tailscale/ZeroTier/WireGuard IP、Cloudflare Tunnel 或局域网地址；原生客户端仅允许回环地址使用 HTTP。"
              rules={[{ required: true, message: '请输入 Server URL' }]}
            >
              <Input placeholder="https://aih.example.com" inputMode="url" autoCapitalize="off" autoCorrect="off" aria-label="Server URL" />
            </FabricFormItem>
            {servers.endpointHints.length > 0 ? (
              <div className={styles.hints}>
                {servers.endpointHints.map((hint) => (
                  <Button
                    key={`${hint.source}:${hint.endpoint}`}
                    size="small"
                    type={hint.recommended ? 'primary' : 'default'}
                    icon={<LinkOutlined />}
                    onClick={() => form.setFieldsValue({ endpoint: hint.endpoint })}
                  >
                    {formatEndpointHintLabel(hint)}
                  </Button>
                ))}
                {servers.endpointWarnings.slice(0, 2).map((warning) => (
                  <p key={warning} className={fabric.note}>{warning}</p>
                ))}
              </div>
            ) : null}
            <FabricFormItem name="name" label="显示名称">
              <Input placeholder="Home AIH" aria-label="显示名称" />
            </FabricFormItem>
            <FabricFormItem
              name="managementKey"
              label="Management Key"
              required
              hint="Server 管理密钥，用于读取账号和会话。可通过 aih server config --show-secrets 查看。"
              rules={[{ required: true, message: '请输入 Management Key' }]}
            >
              <Input.Password autoComplete="new-password" placeholder="Management Key" aria-label="Management Key" />
            </FabricFormItem>
          </Form>
        ) : null}
      </DetailSheet>
    </MobilePage>
  );
}

function ServerDetail({
  row,
  onCopy,
  onRemove
}: {
  row: ServerRouteRow;
  onCopy: (endpoint: string) => void;
  onRemove: () => void;
}) {
  const { profile } = row;
  const status = rowStatus(row);
  const metrics = row.authorizationPending ? '输入 Management Key 后即可连接' : metricsText(profile) || '尚未同步';
  return (
    <div className={styles.detail}>
      <KeyValue
        rows={[
          { key: 'status', label: '状态', value: <StatusText tone={status.tone} label={status.label} /> },
          { key: 'auth', label: '授权', value: row.authorizationPending ? SERVER_PENDING_AUTH_LABEL : row.authorizationLabel },
          {
            key: 'key',
            label: 'Management Key',
            value: isControlPlaneManagementKeyConfigured(profile) ? 'Key 已配置' : '未配置',
            tone: isControlPlaneManagementKeyConfigured(profile) ? 'ok' : 'warn'
          },
          { key: 'metrics', label: '数据', value: metrics, mono: false },
          { key: 'stable', label: 'Server ID', value: row.stableServerId },
          { key: 'param', label: '显式参数', value: `server=${profile.id}` },
          ...(profile.lastError ? [{ key: 'error', label: '错误', value: profile.lastError, tone: 'err' as const }] : [])
        ]}
      />

      <div className={styles.detailBlock}>
        <span className="hud-label">Server 地址</span>
        <div className={fabric.endpoint}>
          <code>{profile.endpoint}</code>
          <HudIconButton icon={<CopyOutlined />} label="复制 Server URL" onClick={() => onCopy(profile.endpoint)} />
        </div>
      </div>

      {row.routes.length > 0 ? (
        <div className={styles.detailBlock}>
          <span className="hud-label">连接路径 · {row.routes.length}</span>
          <ul className={styles.routes}>
            {row.routes.map((route) => {
              const tone = ROUTE_HEALTH_TONE[route.healthColor] || 'muted';
              return (
                <li key={route.id} className={styles.route}>
                  <span className={`hud-led hud-led--${tone === 'muted' ? 'info' : tone}`} aria-hidden="true" />
                  <span className={styles.routeMain}>
                    <span className={styles.routeKind}>
                      {route.kindLabel}
                      {route.primary ? <span className={fabric.badge}>{route.roleLabel}</span> : null}
                    </span>
                    <code className={styles.routeEndpoint}>{route.endpointLabel}</code>
                  </span>
                  <span className={styles.routeSide}>
                    <span className={`mhud-tone--${tone}`}>{route.healthLabel}</span>
                    <span>{route.rttLabel}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* 待授权行的「授权 / 移除」已在抽屉页脚；已授权行在此补充「打开 / 移除」 */}
      {!row.authorizationPending ? (
        <div className={fabric.sheetActions}>
          <Button
            icon={<ExportOutlined />}
            href={buildServerScopedAppHref('/dashboard', profile.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={onRemove}>
            移除
          </Button>
        </div>
      ) : null}
    </div>
  );
}
