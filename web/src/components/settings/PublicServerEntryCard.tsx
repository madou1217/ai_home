import { useState } from 'react';
import { Alert, Divider, Select, Tag, Typography, message } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { ProCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import type { ControlPlaneProfile } from '@/types';
import {
  configureNativeFrpRoute,
  configureNativeOutboundRelays
} from '@/services/native-server-profile-repository';
import type {
  NativeFrpRouteConfigureResult,
  NativeOutboundRelayConfigureResult
} from '@/services/native-server-profile-repository';
import {
  buildFrpPublicServerStatusRows,
  buildPublicServerStatusRows,
  validateFrpPublicServerSelection,
  validatePublicServerSelection
} from '@/services/public-server-entry';

interface PublicServerEntryCardProps {
  profiles: ControlPlaneProfile[];
}

function configurationErrorMessage(error: unknown, fallback: string) {
  const reason = error instanceof Error ? error.message.trim() : '';
  return reason && !/^[a-z][a-z0-9_.:-]+$/iu.test(reason) ? reason : fallback;
}

const PublicServerEntryCard = ({ profiles }: PublicServerEntryCardProps) => {
  const [localProfileId, setLocalProfileId] = useState('');
  const [publicProfileIds, setPublicProfileIds] = useState<string[]>([]);
  const [noPortProfileIds, setNoPortProfileIds] = useState<string[]>([]);
  const [configuringPublicEntry, setConfiguringPublicEntry] = useState(false);
  const [configuringNoPortEntry, setConfiguringNoPortEntry] = useState(false);
  const [publicEntryResult, setPublicEntryResult] = useState<NativeOutboundRelayConfigureResult | null>(null);
  const [noPortEntryResult, setNoPortEntryResult] = useState<NativeFrpRouteConfigureResult | null>(null);

  const authorizedProfiles = profiles.filter((profile) => (
    profile.managementKeyConfigured && profile.authorizationState === 'authorized'
  ));
  const selectedPublicProfiles = publicProfileIds
    .map((profileId) => authorizedProfiles.find((profile) => profile.id === profileId) || null)
    .filter((profile): profile is ControlPlaneProfile => Boolean(profile));
  const selectedNoPortProfiles = noPortProfileIds
    .map((profileId) => authorizedProfiles.find((profile) => profile.id === profileId) || null)
    .filter((profile): profile is ControlPlaneProfile => Boolean(profile));
  const publicStatusRows = buildPublicServerStatusRows(selectedPublicProfiles, publicEntryResult);
  const noPortStatusRows = buildFrpPublicServerStatusRows(selectedNoPortProfiles, noPortEntryResult);
  const publicProfileOptions = authorizedProfiles
    .filter((profile) => profile.id !== localProfileId)
    .map((profile) => ({ value: profile.id, label: profile.name || profile.endpoint }));

  const handleLocalProfileChange = (profileId: string) => {
    setLocalProfileId(profileId);
    setPublicProfileIds((current) => current.filter((id) => id !== profileId));
    setNoPortProfileIds((current) => current.filter((id) => id !== profileId));
    setPublicEntryResult(null);
    setNoPortEntryResult(null);
  };

  const handlePublicProfilesChange = (profileIds: string[]) => {
    setPublicProfileIds(Array.from(new Set(profileIds))
      .filter((profileId) => profileId !== localProfileId)
      .slice(0, 5));
    setPublicEntryResult(null);
  };

  const handleNoPortProfilesChange = (profileIds: string[]) => {
    setNoPortProfileIds(Array.from(new Set(profileIds))
      .filter((profileId) => profileId !== localProfileId)
      .slice(0, 5));
    setNoPortEntryResult(null);
  };

  const handleConfigurePublicEntry = async () => {
    const selection = validatePublicServerSelection(profiles, localProfileId, publicProfileIds);
    if (!selection.ok) {
      message.error(selection.message);
      return;
    }
    setConfiguringPublicEntry(true);
    try {
      const result = await configureNativeOutboundRelays(
        selection.localProfile.id,
        selection.publicProfiles.map((profile) => profile.id)
      );
      setPublicEntryResult(result);
      message.success(`已为 ${selection.localProfile.name} 配置 ${selection.publicProfiles.length} 个公网入口`);
    } catch (error) {
      message.error(configurationErrorMessage(error, '公网入口配置失败'));
    } finally {
      setConfiguringPublicEntry(false);
    }
  };

  const handleConfigureNoPortEntry = async () => {
    const selection = validateFrpPublicServerSelection(profiles, localProfileId, noPortProfileIds);
    if (!selection.ok) {
      message.error(selection.message);
      return;
    }
    setConfiguringNoPortEntry(true);
    try {
      const result = await configureNativeFrpRoute(
        selection.localProfile.id,
        selection.publicProfiles.map((profile) => profile.id)
      );
      setNoPortEntryResult(result);
      const readyCount = result.visitors.filter((visitor) => visitor.status === 'ready').length;
      if (!result.ok) {
        message.error('未建立可用入口，请确认所选 Server 的 frpc 连接到同一 FRPS');
      } else if (result.partial) {
        message.warning(`已有 ${readyCount} 个入口可用，其他入口连接验证失败`);
      } else {
        message.success(`已通过 ${readyCount} 个公网 Server 建立无需新增端口的入口`);
      }
    } catch (error) {
      message.error(configurationErrorMessage(error, '无需新增端口的入口配置失败'));
    } finally {
      setConfiguringNoPortEntry(false);
    }
  };

  return (
    <ProCard className="settings-panel settings-public-entry-card" bordered bodyStyle={{ padding: 18 }}>
      <div className="settings-panel-head">
        <div>
          <h2>公网入口</h2>
          <p>让无法被外网直接访问的 Server 主动连接多个公网 Server。</p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        message="直接使用客户端安全保存的 Management Key，无需重复输入。"
      />

      <div className="settings-public-entry-fields">
        <label className="settings-public-entry-field">
          <span>需要外网访问的 Server</span>
          <Select
            value={localProfileId || undefined}
            placeholder="选择 Server"
            onChange={handleLocalProfileChange}
            options={authorizedProfiles.map((profile) => ({
              value: profile.id,
              label: profile.name || profile.endpoint
            }))}
          />
        </label>

        <label className="settings-public-entry-field">
          <span>公网 Server（1–5 个）</span>
          <Select
            mode="multiple"
            value={publicProfileIds}
            placeholder="选择至少 1 个公网 Server"
            maxCount={5}
            maxTagCount="responsive"
            onChange={handlePublicProfilesChange}
            options={publicProfileOptions}
          />
        </label>
      </div>

      <div className="settings-public-entry-actions">
        <Typography.Text type="secondary">
          已选择 {publicProfileIds.length} 个公网 Server
        </Typography.Text>
        <Button
          type="primary"
          icon={<LinkOutlined />}
          loading={configuringPublicEntry}
          disabled={!localProfileId || publicProfileIds.length < 1}
          onClick={handleConfigurePublicEntry}
        >
          保存公网入口
        </Button>
      </div>

      {publicStatusRows.length > 0 && (
        <div className="settings-public-entry-status-list">
          {publicStatusRows.map((row) => (
            <div key={row.profileId} className="settings-public-entry-status">
              <div className="settings-public-entry-status-main">
                <strong>{row.name}</strong>
                <span>{row.endpoint}</span>
              </div>
              <div className="settings-public-entry-status-meta">
                <Tag color={row.statusColor}>{row.statusLabel}</Tag>
                {row.retryLabel && <span>{row.retryLabel}</span>}
                {row.attempts > 0 && <span>尝试 {row.attempts} 次</span>}
              </div>
              {row.lastError && <span className="settings-public-entry-error">{row.lastError}</span>}
            </div>
          ))}
        </div>
      )}

      <Divider />

      <div className="settings-public-entry-mode">
        <strong>无需新增端口</strong>
        <p>复用现有 FRP 连接，无需新增端口；所选 Server 必须连接同一 FRPS，系统会逐一验证。</p>
      </div>

      <label className="settings-public-entry-field">
        <span>已配置 frpc 的公网 Server（1–5 个）</span>
        <Select
          mode="multiple"
          value={noPortProfileIds}
          placeholder="选择至少 1 个公网 Server"
          maxCount={5}
          maxTagCount="responsive"
          onChange={handleNoPortProfilesChange}
          options={publicProfileOptions}
        />
      </label>

      <div className="settings-public-entry-actions">
        <Typography.Text type="secondary">
          已选择 {noPortProfileIds.length} 个公网 Server
        </Typography.Text>
        <Button
          icon={<LinkOutlined />}
          loading={configuringNoPortEntry}
          disabled={!localProfileId || noPortProfileIds.length < 1}
          onClick={handleConfigureNoPortEntry}
        >
          配置无需新增端口的入口
        </Button>
      </div>

      {noPortStatusRows.length > 0 && (
        <div className="settings-public-entry-status-list">
          {noPortStatusRows.map((row) => (
            <div key={row.profileId} className="settings-public-entry-status">
              <div className="settings-public-entry-status-main">
                <strong>{row.name}</strong>
                <span>{row.endpoint}</span>
              </div>
              <div className="settings-public-entry-status-meta">
                <Tag color={row.statusColor}>{row.statusLabel}</Tag>
                <span>{row.bindPortLabel}</span>
              </div>
              {row.lastError && <span className="settings-public-entry-error">{row.lastError}</span>}
            </div>
          ))}
        </div>
      )}
    </ProCard>
  );
};

export default PublicServerEntryCard;
