import { providerNames } from './provider-names.js';

export function getProviderTagColor(provider) {
  if (provider === 'codex') return 'green';
  if (provider === 'claude') return 'orange';
  return 'blue';
}

export function getProviderLabel(provider) {
  return providerNames[provider] || provider || 'AI';
}
