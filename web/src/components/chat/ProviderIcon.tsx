import type { Provider } from '@/types';
import { useEffect, useMemo, useState } from 'react';
import { getProviderIcon, getProviderLabel, getProviderTerminalIcon, getProviderTerminalIconAssetUrl, providerIds } from './provider-registry';
import './ProviderIcon.css';

export { providerIds, providerNames } from './provider-registry';

interface Props {
  provider: Provider | string;
  size?: number;
  className?: string;
  variant?: 'brand' | 'terminal';
  fallbackLabel?: string;
}

/**
 * 深色主题下的品牌图可见性处理（浅色主题完全不变，见 ProviderIcon.css）：
 * - invert：纯黑单色记号（Grok）与低对比中性记号（OpenCode）在深色表面上会消失，深色下反相；
 * - tile / round：自带深色圆角底板 / 圆形底的记号（Kimi、ZCode、CodeBuddy 家族、Qoder），
 *   深色下底板与表面融为一体，加 1px 中性描边勾出轮廓。
 */
const DARK_THEME_ICON_TREATMENT: Partial<Record<Provider, 'invert' | 'tile' | 'round'>> = {
  grok: 'invert',
  opencode: 'invert',
  kimi: 'tile',
  zcode: 'tile',
  codebuddy: 'tile',
  codebuddycn: 'tile',
  workbuddy: 'tile',
  workbuddycn: 'tile',
  qoder: 'round',
  qodercn: 'round'
};

const ProviderIcon = ({ provider, size = 16, className, variant = 'brand', fallbackLabel }: Props) => {
  const knownProvider = providerIds.includes(provider as Provider);
  const label = knownProvider ? getProviderLabel(provider) : String(provider || 'AIH').trim().toUpperCase();
  const src = knownProvider
    ? (variant === 'terminal' ? getProviderTerminalIconAssetUrl(provider) : getProviderIcon(provider))
    : '';
  const assetKey = `${variant}:${provider}:${src}`;
  const [failedAssetKey, setFailedAssetKey] = useState('');
  const fallbackText = useMemo(() => (
    variant === 'terminal' ? getProviderTerminalIcon(provider) : fallbackLabel || label.slice(0, 2).toUpperCase()
  ), [fallbackLabel, label, provider, variant]);

  useEffect(() => {
    setFailedAssetKey('');
  }, [assetKey]);

  if (!src || failedAssetKey === assetKey) {
    return (
      <span
        aria-label={label}
        className={className}
        data-provider-icon-fallback="true"
        data-provider-icon-variant={variant}
        role="img"
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.max(10, Math.round(size * 0.72)),
          lineHeight: 1
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={label}
      className={className}
      data-provider-icon-variant={variant}
      data-provider-icon-dark={variant === 'brand' ? DARK_THEME_ICON_TREATMENT[provider as Provider] : undefined}
      onError={() => setFailedAssetKey(assetKey)}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
};

export default ProviderIcon;
