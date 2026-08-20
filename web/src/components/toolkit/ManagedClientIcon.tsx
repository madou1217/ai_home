import { AppstoreOutlined, CodeOutlined, DesktopOutlined } from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { getProviderLabel } from '@/components/chat/provider-registry';

export type ManagedClientType = 'cli' | 'desktop' | 'ide' | 'terminal';

interface Props {
  clientType: ManagedClientType;
  clientName: string;
  provider?: string;
  integrationProviders?: string[];
}

function normalizeProviderIds(values: string[] | undefined) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

/** 所有 Toolkit 客户端共用的身份图标。宿主图标与 Provider 角标分离，支持一个 IDE 承载多个 Provider。 */
export default function ManagedClientIcon({ clientType, clientName, provider = '', integrationProviders }: Props) {
  const integrations = normalizeProviderIds(integrationProviders);
  const providerBadges = clientType === 'cli' || clientType === 'desktop'
    ? normalizeProviderIds([provider, ...integrations])
    : integrations;
  const label = integrations.length
    ? `${clientName}，承载 ${integrations.map((id) => getProviderLabel(id)).join('、')}`
    : clientName;
  const hostIcon = clientType === 'cli' || clientType === 'ide'
    ? <CodeOutlined />
    : clientType === 'desktop'
      ? <DesktopOutlined />
      : <AppstoreOutlined />;

  return (
    <span className="toolkit-managed-app-icon" role="img" aria-label={label}>
      <span className="toolkit-client-glyph" aria-hidden="true">{hostIcon}</span>
      {providerBadges.length > 0 ? (
        <span className="toolkit-provider-badges" aria-hidden="true">
          {providerBadges.map((id) => (
            <span className="toolkit-provider-badge" key={id}>
              <ProviderIcon provider={id} size={14} fallbackLabel={id.toUpperCase().slice(0, 3)} />
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
