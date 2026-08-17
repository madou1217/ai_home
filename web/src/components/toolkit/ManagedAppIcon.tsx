import { CodeOutlined } from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { getProviderLabel, providerIds } from '@/components/chat/provider-registry';
import type { ManagedAppItem, Provider } from '@/types';

interface Props {
  app: ManagedAppItem;
}

function normalizeProviderIds(values: string[] | undefined) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .filter((value) => providerIds.includes(value as Provider));
}

/**
 * 应用身份图标：IDE 先显示宿主，再叠加它承载的 Provider。
 * 这样 VS Code 同时配置 Codex、Claude 时无需伪装成某一个 Provider 图标。
 */
export default function ManagedAppIcon({ app }: Props) {
  const integrations = normalizeProviderIds(app.integrationProviders);
  const clientLabel = app.clientName || app.name;
  const label = integrations.length > 0
    ? `${clientLabel}，承载 ${integrations.map((provider) => getProviderLabel(provider)).join('、')}`
    : clientLabel;

  return (
    <span className="toolkit-managed-app-icon" role="img" aria-label={label}>
      {app.type === 'ide' ? (
        <span className="toolkit-client-glyph" aria-hidden="true">
          <CodeOutlined />
        </span>
      ) : (
        <ProviderIcon provider={app.provider as Provider} size={28} />
      )}
      {integrations.length > 0 ? (
        <span className="toolkit-provider-badges" aria-hidden="true">
          {integrations.map((provider) => (
            <span className="toolkit-provider-badge" key={provider}>
              <ProviderIcon provider={provider as Provider} size={14} />
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
