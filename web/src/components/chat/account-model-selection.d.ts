import type { Session, WebUiModelsResponse } from '@/types';

export function listAccountEnabledModels(catalog: Partial<WebUiModelsResponse> | null | undefined, accountRef: string): string[];
export function getAccountDefaultModel(catalog: Partial<WebUiModelsResponse> | null | undefined, accountRef: string): string;
export function listAihServerModels(catalog: Partial<WebUiModelsResponse> | null | undefined, provider: string): string[];
export function resolveEffectiveSelectedModel(selectedModel: string, modelIds: readonly string[]): string;
export function getSessionModelKey(session: Session | null | undefined): string;
export function rememberSessionModel(session: Session | null | undefined, model: string): void;
export function recallSessionModel(session: Session | null | undefined): string;
