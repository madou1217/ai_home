import { message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { modelAliasesAPI, modelsAPI, type ModelAlias } from '@/services/api';
import {
  findAliasModelLabel,
  getAliasModelLabel,
  sortModelAliases
} from './model-alias-presentation';

/**
 * 优先展示服务端给出的原因（detail / error），而不是 axios 的
 * 「Request failed with status code 400」——后者让人无从判断是哪条记录、为什么被拒。
 */
const errorText = (error: unknown, fallback: string) => {
  const data = (error as { response?: { data?: { detail?: string; error?: string } } } | null)?.response?.data;
  return data?.detail || data?.error || (error as { message?: string } | null)?.message || fallback;
};

/**
 * 模型别名数据与动作：modelAliasesAPI.getAll / create / update / replace / toggle，
 * 目标模型候选来自 modelAliasesAPI.listTargets，显示名来自 modelsAPI.listCatalog。桌面 ModelAliases 与移动端设置共用，提示文案一致。
 */
export function useModelAliases() {
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [modelLabels, setModelLabels] = useState<Record<string, Record<string, string>>>({});
  const [modelsLoading, setModelsLoading] = useState(false);

  const fetchAliases = useCallback(async () => {
    setLoading(true);
    try {
      const data = await modelAliasesAPI.getAll();
      setAliases(data);
    } catch (error: unknown) {
      message.error(errorText(error, '获取模型别名失败'));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  const fetchModels = useCallback(async (notify = false) => {
    setModelsLoading(true);
    try {
      // 候选取服务端别名目标列表（与保存校验同一判据），显示名仍取模型目录。
      // 此前直接用 /webui/models 的原始目录：里面有已在模型设置里关掉、或背后账号不在运行池的模型，
      // 选中后保存必然 400。
      const [targets, data] = await Promise.all([modelAliasesAPI.listTargets(), modelsAPI.listCatalog()]);
      setModelsByProvider(targets);
      setModelLabels(data.labels || {});
      if (notify) message.success('模型缓存已重新读取');
    } catch (error: unknown) {
      message.error(errorText(error, '获取模型列表失败'));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAliases();
    fetchModels();
  }, [fetchAliases, fetchModels]);

  const sortedAliases = useMemo(() => sortModelAliases(aliases), [aliases]);

  const getModelLabel = useCallback(
    (provider: string, model: string) => getAliasModelLabel(modelLabels, provider, model),
    [modelLabels]
  );
  const findModelLabel = useCallback((model: string) => findAliasModelLabel(modelLabels, model), [modelLabels]);
  const providerHasModel = useCallback(
    (provider: string, model: string) => (modelsByProvider[provider] || []).includes(model),
    [modelsByProvider]
  );

  /** 删除一组记录（聚合行）：一次请求原子完成，不会删到一半。 */
  const deleteAliases = useCallback(async (ids: string[]) => {
    try {
      await modelAliasesAPI.replace(ids, []);
      message.success('删除成功');
      return true;
    } catch (error: unknown) {
      message.error(errorText(error, '删除失败'));
      return false;
    } finally {
      fetchAliases();
    }
  }, [fetchAliases]);

  const deleteAlias = useCallback((id: string) => deleteAliases([id]), [deleteAliases]);

  const toggleAlias = useCallback(async (id: string) => {
    try {
      await modelAliasesAPI.toggle(id);
      message.success('状态已更新');
      fetchAliases();
    } catch (error: unknown) {
      message.error(errorText(error, '更新状态失败'));
    }
  }, [fetchAliases]);

  /**
   * 新增或覆盖一组别名记录；成功返回 true。
   *
   * replaceIds 非空即编辑聚合行：服务端先校验全部新记录，通过后才删旧写新，
   * 校验失败时旧记录原样保留。多选提交时 values 带 `records`（expandAliasSelections 的产物），
   * 存储仍是一条一个 (provider, model)，运行时语义不变。
   */
  const saveAlias = useCallback(async (
    replaceIds: string[] | null,
    values: Partial<ModelAlias> & { records?: Array<Partial<ModelAlias>> }
  ) => {
    const { records: expanded, ...single } = values;
    const records = Array.isArray(expanded) && expanded.length > 0 ? expanded : [single];
    try {
      await modelAliasesAPI.replace(replaceIds || [], records);
      if (replaceIds && replaceIds.length > 0) message.success('更新成功');
      else message.success(records.length > 1 ? `已添加 ${records.length} 条别名` : '添加成功');
      return true;
    } catch (error: unknown) {
      message.error(errorText(error, '保存失败'));
      return false;
    } finally {
      fetchAliases();
    }
  }, [fetchAliases]);

  return {
    aliases,
    sortedAliases,
    loading,
    loaded,
    modelsByProvider,
    modelLabels,
    modelsLoading,
    fetchAliases,
    fetchModels,
    getModelLabel,
    findModelLabel,
    providerHasModel,
    deleteAlias,
    deleteAliases,
    toggleAlias,
    saveAlias
  };
}
