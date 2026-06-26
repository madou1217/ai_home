import type { WebUiModelsResponse } from '@/types';

export function listAccountEnabledModels(catalog: Partial<WebUiModelsResponse> | null | undefined, accountRef: string): string[];
