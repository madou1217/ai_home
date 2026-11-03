export type TranslationTargetState = 'configured' | 'pending' | 'unavailable';

export interface TranslationTargetStatusInput {
  available: boolean;
  configured: boolean;
}

export interface TranslationTargetStatus {
  state: TranslationTargetState;
  label: '已配置' | '待配置' | '不可用';
  selectable: boolean;
}

export interface TranslationProviderStatusInput {
  executable: boolean;
  configured: boolean;
}

export interface TranslationProviderStatus extends TranslationTargetStatus {
  label: '已配置' | '待配置' | '不可用';
}

export function getTranslationTargetStatus(target: TranslationTargetStatusInput): TranslationTargetStatus {
  if (!target.available) return { state: 'unavailable', label: '不可用', selectable: false };
  if (!target.configured) return { state: 'pending', label: '待配置', selectable: false };
  return { state: 'configured', label: '已配置', selectable: true };
}

export function getTranslationProviderStatus(provider: TranslationProviderStatusInput): TranslationProviderStatus {
  return getTranslationTargetStatus({ available: provider.executable, configured: provider.configured });
}

/**
 * Translation UI state is rendered inline. Keep the page free of large Alert
 * blocks and decorative left-edge status bars as the page grows.
 */
export function hasForbiddenTranslationDecoration(source: string): boolean {
  return /<Alert\b|border-left\s*:|inset\s+[^;]*border-left/i.test(source);
}
