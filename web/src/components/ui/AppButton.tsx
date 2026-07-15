import { Button as AntButton } from 'antd';
import type { ButtonProps } from 'antd';
import { useMemo } from 'react';
import { useDebouncedAction } from '@/hooks/useDebouncedAction';

type AppButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'icon';

export interface AppButtonProps extends ButtonProps {
  appVariant?: AppButtonVariant;
  debounceMs?: number;
  disableDebounce?: boolean;
}

function resolveVariant({
  appVariant,
  danger,
  shape,
  type,
  children
}: Pick<AppButtonProps, 'appVariant' | 'danger' | 'shape' | 'type' | 'children'>): AppButtonVariant {
  if (appVariant) return appVariant;
  if (danger) return 'danger';
  if (shape === 'circle' || !children) return 'icon';
  if (type === 'primary') return 'primary';
  if (type === 'text' || type === 'link') return 'quiet';
  return 'secondary';
}

function joinClassNames(...items: Array<string | undefined | false>) {
  return items.filter(Boolean).join(' ');
}

const AppButton = ({
  appVariant,
  className,
  debounceMs,
  disabled,
  disableDebounce,
  loading,
  onClick,
  ...props
}: AppButtonProps) => {
  const guardedClick = useDebouncedAction(onClick, {
    wait: debounceMs,
    disabled: disableDebounce || disabled || Boolean(loading) || !onClick
  });
  const variant = resolveVariant({ ...props, appVariant });
  const buttonClassName = useMemo(() => joinClassNames(
    'app-button',
    `app-button--${variant}`,
    className
  ), [className, variant]);

  return (
    <AntButton
      {...props}
      className={buttonClassName}
      disabled={disabled}
      loading={loading}
      onClick={guardedClick}
    />
  );
};

export default AppButton;
