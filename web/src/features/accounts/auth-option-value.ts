import type { AccountAuthMode } from '@/types';

export type AuthOptionSelection = {
  authMode: AccountAuthMode | '';
  authStrategy: string;
};

export function getAuthOptionValue(option: { value: string; strategy?: string }): string {
  return option.strategy ? `${option.value}::${option.strategy}` : option.value;
}

export function splitAuthOptionValue(value: unknown): AuthOptionSelection {
  const [authMode = '', authStrategy = ''] = String(value || '').split('::', 2);
  return { authMode: authMode as AccountAuthMode | '', authStrategy };
}
