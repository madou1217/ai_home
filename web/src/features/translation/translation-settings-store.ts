// AI 翻译的运行时设置缓存（页面与全局划词浮层共用）。
//
// 需求：from / to / model 三项都能设默认值，且「页面里改一次」与「划词浮层里用一次」
// 必须是同一份设置——否则用户每次划词都要重选语言。因此这里做三件事：
//   1. 一次性拉取 settings + languages + models（三者一起返回给 UI，避免三处各拉一遍）；
//   2. 变更后立刻回写服务端，并把结果广播给所有订阅者（页面、浮层、移动端）；
//   3. 连续修改只认最后一次响应，避免慢请求把新选择覆盖回旧值。

import { translationAPI } from '@/services/api';
import type {
  TranslationLanguage,
  TranslationModelOption,
  TranslationRoutePreference,
  TranslationSettings,
} from '@/types';

export type TranslationCopyScope = 'selection' | 'page' | 'all';
export type TranslationCopyMode = 'selection' | 'replace-selection' | 'page-side-by-side' | 'page-replace';
export interface TranslationCopyEvent { type: string; text?: string; }

export interface TranslationBootstrap {
  settings: TranslationSettings;
  /** 服务端根据当前可用账号推断的默认模型（settings.model 为空时用它） */
  autoModel: string;
  autoProvider: string;
  languages: TranslationLanguage[];
  models: TranslationModelOption[];
  /** 模型目录里的默认值（等价于 autoModel，保留字段名与接口一致） */
  defaultModel: string;
  defaultProvider: string;
}

type Listener = (bootstrap: TranslationBootstrap) => void;

let cached: TranslationBootstrap | null = null;
let inflight: Promise<TranslationBootstrap> | null = null;
let saveSequence = 0;
const listeners = new Set<Listener>();
const ROUTE_OPERATIONS = new Set<TranslationRoutePreference['operations'][number]>(['selection', 'batch', 'page', 'replace']);

export function normalizeTranslationRoutes(routes: unknown, legacy: Partial<Pick<TranslationSettings, 'model' | 'provider'>> = {}): TranslationRoutePreference[] {
  // An omitted field is an old settings record and can be migrated from the
  // legacy model/provider pair. An explicit [] means the user cleared all
  // routes and must remain empty.
  if (routes === undefined) {
    const accountProvider = String(legacy.provider || '').trim().toLowerCase();
    const model = String(legacy.model || '').trim();
    return accountProvider && model ? [{ id: `aih-gateway:${model}:${accountProvider}`, provider: 'aih-gateway', model, modelProvider: accountProvider, enabled: true, priority: 0, operations: ['selection'] }] : [];
  }
  if (!Array.isArray(routes)) return [];
  const seenIds = new Set<string>();
  const normalized: TranslationRoutePreference[] = [];
  routes.forEach((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    const provider = String(input.provider || '').trim().toLowerCase();
    const model = String(input.model || '').trim();
    if (!provider || !model) return;
    const operations = Array.isArray(input.operations) ? Array.from(new Set(input.operations.map((item) => String(item || '').trim().toLowerCase()).filter((item): item is TranslationRoutePreference['operations'][number] => ROUTE_OPERATIONS.has(item as TranslationRoutePreference['operations'][number])))) : [];
    const fallbackId = `route:${provider}:${model}`;
    const id = String(input.id || fallbackId).trim().slice(0, 200) || fallbackId;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const modelProvider = String(input.modelProvider || '').trim().toLowerCase();
    normalized.push({ id, provider, model, ...(modelProvider ? { modelProvider } : {}), enabled: input.enabled !== false, priority: normalized.length, operations: operations.length ? operations : ['selection'] });
  });
  return normalized;
}

export function shouldAutoCopy({ scope, client, mode, event }: { scope: TranslationCopyScope; client: string; mode: TranslationCopyMode; event: TranslationCopyEvent | null | undefined }): boolean {
  if (!event || event.type !== 'done' || !String(event.text || '').trim() || !String(client || '').trim()) return false;
  if (scope === 'all') return true;
  if (scope === 'selection') return mode === 'selection' || mode === 'replace-selection';
  return scope === 'page' && (mode === 'page-side-by-side' || mode === 'page-replace');
}

export async function writeTranslationClipboard(text: string): Promise<void> { await navigator.clipboard.writeText(text); }

export function normalizeTranslationSettings(raw: Partial<TranslationSettings> | null | undefined): TranslationSettings {
  const input = raw && typeof raw === 'object' ? raw : {};
  const targetPolicy = input.targetPolicy;
  const copyScope = input.copyScope;
  const source = String(input.source || 'auto').trim();
  const target = String(input.target || 'zh-Hans').trim();
  const normalizeProvider = (value: unknown) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const normalizeModel = (value: unknown) => String(value || '').trim().slice(0, 200);
  return { source: source || 'auto', target: target || 'zh-Hans', model: normalizeModel(input.model), provider: normalizeProvider(input.provider), systemEnabled: input.systemEnabled === true, targetPolicy: targetPolicy === 'explicit' || targetPolicy === 'confirm' || targetPolicy === 'same-language' ? targetPolicy : 'saved', autoCopy: input.autoCopy === true, copyScope: copyScope === 'page' || copyScope === 'all' ? copyScope : 'selection', routes: normalizeTranslationRoutes(input.routes, input), updatedAt: Number.isFinite(Number(input.updatedAt)) ? Math.max(0, Math.floor(Number(input.updatedAt))) : 0 };
}

function notify() {
  if (!cached) return;
  const snapshot = cached;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (_error) {
      // 订阅者自己的渲染错误不能中断其它订阅者。
    }
  }
}

/** 已缓存时同步返回，供浮层在打开瞬间判断目标语言标签。 */
export function getTranslationBootstrap(): TranslationBootstrap | null {
  return cached;
}

export function subscribeTranslationBootstrap(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadTranslationBootstrap(force = false): Promise<TranslationBootstrap> {
  if (!force && cached) return cached;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    const [settingsResponse, languagesResponse, modelsResponse] = await Promise.all([
      translationAPI.getSettings(),
      translationAPI.listLanguages(),
      translationAPI.listModels(),
    ]);
    const next: TranslationBootstrap = {
      settings: normalizeTranslationSettings(settingsResponse.settings),
      autoModel: settingsResponse.autoDetectedModel || '',
      autoProvider: settingsResponse.autoDetectedProvider || '',
      languages: languagesResponse.languages || [],
      models: modelsResponse.models || [],
      defaultModel: modelsResponse.defaultModel || '',
      defaultProvider: modelsResponse.defaultProvider || '',
    };
    cached = next;
    notify();
    return next;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * 保存默认值（部分字段）。成功后才更新缓存并广播，失败时抛出由调用方提示。
 */
export async function saveTranslationSettings(
  patch: Partial<Pick<TranslationSettings, 'source' | 'target' | 'model' | 'provider' | 'targetPolicy' | 'autoCopy' | 'copyScope' | 'routes'>>,
): Promise<TranslationSettings> {
  const sequence = ++saveSequence;
  const response = await translationAPI.saveSettings(patch);
  if (sequence === saveSequence && cached) {
    cached = { ...cached, settings: normalizeTranslationSettings(response.settings) };
    notify();
  }
  return normalizeTranslationSettings(response.settings);
}

/** 只在本地更新缓存（例如页面初始化把服务端默认值落到控件上时使用）。 */
export function applyTranslationSettings(settings: TranslationSettings) {
  if (!cached) return;
  cached = { ...cached, settings: normalizeTranslationSettings(settings) };
  notify();
}

/** 测试用：清空模块级缓存，避免用例之间互相污染。 */
export function resetTranslationBootstrapForTests() {
  cached = null;
  inflight = null;
  saveSequence = 0;
  listeners.clear();
}
