import { useCallback, useEffect, useState } from 'react';
import { modelsAPI } from '@/services/api';
import type { OpenAIModelItem } from '@/types';
import { extractApiErrorMessage, normalizeStringList } from './client-key-presentation';

type OpenAIModelItemWithProviders = OpenAIModelItem & {
  providers?: string[];
};

function deriveByProviderFromOpenAIItems(items: readonly OpenAIModelItemWithProviders[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  items.forEach((item) => {
    const modelId = String(item?.id || '').trim();
    if (!modelId) return;
    const providers = Array.isArray(item.providers) ? item.providers : [];
    providers.forEach((provider: string) => {
      const key = String(provider || '').trim();
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(modelId);
    });
  });
  Object.keys(map).forEach((provider) => {
    map[provider] = normalizeStringList(map[provider], 'alpha');
  });
  return map;
}

function normalizeByProviderMap(raw: Record<string, string[]> | undefined | null): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return next;
  Object.entries(raw).forEach(([provider, list]) => {
    const key = String(provider || '').trim();
    if (!key) return;
    const normalized = normalizeStringList(list, 'alpha');
    if (normalized.length > 0) next[key] = normalized;
  });
  return next;
}

/**
 * 加载客户端 API Key 模型池所需的「按 Provider 分组模型目录 + 显示名」。
 * 优先使用 OpenAI 兼容聚合目录（与网关可路由模型一致），若结果为空或失败则回退到 /webui/models 目录。
 */
export function useClientKeyModelCatalog() {
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [modelLabels, setModelLabels] = useState<Record<string, Record<string, string>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const openAICatalog = await modelsAPI.listOpenAICompatible();
      let byProvider = normalizeByProviderMap(openAICatalog.byProvider);
      if (Object.keys(byProvider).length === 0 && Array.isArray(openAICatalog.data) && openAICatalog.data.length > 0) {
        byProvider = deriveByProviderFromOpenAIItems(openAICatalog.data);
      }
      let labels: Record<string, Record<string, string>> = openAICatalog.labels || {};

      if (Object.keys(byProvider).length === 0) {
        try {
          const fallbackCatalog = await modelsAPI.listCatalog();
          const fallbackModels = normalizeByProviderMap(fallbackCatalog.models);
          if (Object.keys(fallbackModels).length > 0) {
            byProvider = fallbackModels;
          }
          if (Object.keys(labels).length === 0 && fallbackCatalog.labels) {
            labels = fallbackCatalog.labels;
          }
        } catch {
          // 保留主目录空态，不覆盖主链路成功返回
        }
      }

      setModelsByProvider(byProvider);
      setModelLabels(labels);
      setModelsLoaded(true);
    } catch (primaryError: unknown) {
      try {
        const fallbackCatalog = await modelsAPI.listCatalog();
        setModelsByProvider(normalizeByProviderMap(fallbackCatalog.models));
        setModelLabels(fallbackCatalog.labels || {});
        setModelsLoaded(true);
      } catch {
        setModelsError(extractApiErrorMessage(primaryError, '读取模型目录失败'));
      }
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  return {
    modelsByProvider,
    modelLabels,
    modelsLoading,
    modelsLoaded,
    modelsError,
    refreshModels
  };
}
