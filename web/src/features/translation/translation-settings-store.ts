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
  TranslationSettings,
} from '@/types';

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
      settings: settingsResponse.settings,
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
  patch: Partial<Pick<TranslationSettings, 'source' | 'target' | 'model' | 'provider'>>,
): Promise<TranslationSettings> {
  const sequence = ++saveSequence;
  const response = await translationAPI.saveSettings(patch);
  if (sequence === saveSequence && cached) {
    cached = { ...cached, settings: response.settings };
    notify();
  }
  return response.settings;
}

/** 只在本地更新缓存（例如页面初始化把服务端默认值落到控件上时使用）。 */
export function applyTranslationSettings(settings: TranslationSettings) {
  if (!cached) return;
  cached = { ...cached, settings };
  notify();
}

/** 测试用：清空模块级缓存，避免用例之间互相污染。 */
export function resetTranslationBootstrapForTests() {
  cached = null;
  inflight = null;
  saveSequence = 0;
  listeners.clear();
}
