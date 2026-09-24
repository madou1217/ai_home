import { CheckOutlined, CloudServerOutlined, DesktopOutlined, SettingOutlined } from '@ant-design/icons';
import { history } from '@umijs/max';
import { DetailSheet, HudIconButton, MonoList, SwipeRow } from '@/mobile/ui';
import type { ControlPlaneProfile } from '@/types';
import { getProfileStateLabel, isControlPlaneProfileReady, isLocalProfileEndpoint } from './use-settings-servers';

interface Props {
  open: boolean;
  onClose: () => void;
  profiles: ControlPlaneProfile[];
  currentProfileId: string;
  switchingId: string;
  onSelect: (profileId: string) => Promise<boolean>;
}

/** 切换当前连接的 AIH Server（桌面 footer 切换器的移动端形态）；「配置服务器」进入 Server 管理。 */
export default function ServerPickerSheet({ open, onClose, profiles, currentProfileId, switchingId, onSelect }: Props) {
  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="SERVER"
      title="切换 Server"
      footer={(
        <HudIconButton
          icon={<SettingOutlined />}
          label="配置服务器"
          showLabel
          onClick={() => {
            onClose();
            history.push('/fabric/servers');
          }}
        />
      )}
    >
      <MonoList ariaLabel="已保存的 Server">
        {profiles.map((profile) => {
          const selected = profile.id === currentProfileId;
          const ready = isControlPlaneProfileReady(profile);
          return (
            <SwipeRow
              key={profile.id}
              ariaLabel={`切换到 ${profile.name || profile.endpoint}`}
              onTap={async () => {
                if (switchingId) return;
                if (selected) {
                  onClose();
                  return;
                }
                if (await onSelect(profile.id)) onClose();
              }}
            >
              <span className="mhud-row__icon">
                {isLocalProfileEndpoint(profile.endpoint) ? <DesktopOutlined /> : <CloudServerOutlined />}
              </span>
              <span className="mhud-row__main">
                <span className="mhud-row__title">{profile.name || profile.endpoint || profile.id}</span>
                <span className="mhud-row__meta">{profile.endpoint}</span>
              </span>
              <span className="mhud-row__side">
                <span className={`mhud-status ${ready ? 'mhud-tone--ok' : 'mhud-tone--warn'}`}>
                  <span className={`hud-led ${ready ? 'hud-led--ok' : 'hud-led--warn'}`} aria-hidden="true" />
                  {switchingId === profile.id ? '…' : getProfileStateLabel(profile)}
                </span>
                {selected ? <CheckOutlined className="mhud-tone--info" aria-label="当前" /> : null}
              </span>
            </SwipeRow>
          );
        })}
      </MonoList>
    </DetailSheet>
  );
}
