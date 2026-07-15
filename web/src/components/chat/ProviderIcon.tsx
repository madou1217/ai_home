import type { Provider } from '@/types';
import { useEffect, useMemo, useState } from 'react';
import { getProviderIcon, getProviderLabel, getProviderTerminalIcon, getProviderTerminalIconAssetUrl } from './provider-registry';

export { providerIds, providerNames } from './provider-registry';

interface Props {
  provider: Provider;
  size?: number;
  className?: string;
  variant?: 'brand' | 'terminal';
}

const ProviderIcon = ({ provider, size = 16, className, variant = 'brand' }: Props) => {
  const label = getProviderLabel(provider);
  const src = variant === 'terminal' ? getProviderTerminalIconAssetUrl(provider) : getProviderIcon(provider);
  const assetKey = `${variant}:${provider}:${src}`;
  const [failedAssetKey, setFailedAssetKey] = useState('');
  const fallbackText = useMemo(() => (
    variant === 'terminal' ? getProviderTerminalIcon(provider) : label.slice(0, 2).toUpperCase()
  ), [label, provider, variant]);

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
      onError={() => setFailedAssetKey(assetKey)}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
};

export default ProviderIcon;
