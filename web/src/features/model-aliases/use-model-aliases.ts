import { message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { modelAliasesAPI, modelsAPI, type ModelAlias } from '@/services/api';
import {
  findAliasModelLabel,
  getAliasModelLabel,
  sortModelAliases
} from './model-alias-presentation';

const errorText = (error: unknown, fallback: string) => (
  (error as { message?: string } | null)?.message || fallback
);

/**
 * 模型别名数据与动作：modelAliasesAPI.getAll / create / update / delete / toggle，
 * 目标模型候选来自 modelsAPI.listCatalog。桌面 ModelAliases 与移动端设置共用，提示文案一致。
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
      const data = await modelsAPI.listCatalog();
      setModelsByProvider(data.models || {});
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

  const deleteAlias = useCallback(async (id: string) => {
    try {
      await modelAliasesAPI.delete(id);
      message.success('删除成功');
      fetchAliases();
    } catch (error: unknown) {
      message.error(errorText(error, '删除失败'));
    }
  }, [fetchAliases]);

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
   * 新增（editingId 为空）或更新别名；成功返回 true。
   *
   * 多选提交时 values 带 `records`（expandAliasSelections 的产物）：每条各自 create
   * 一次，存储仍是一条一个 (provider, model)，运行时语义不变。编辑态只更新当前这条，
   * 不因多选把同别名的其他记录一并改写。
   */
  const saveAlias = useCallback(async (
    editingId: string | null,
    values: Partial<ModelAlias> & { records?: Array<Partial<ModelAlias>> }
  ) => {
    const records = Array.isArray(values.records) ? values.records : [];
    const { records: _records, ...single } = values;
    try {
      if (editingId) {
        await modelAliasesAPI.update(editingId, single);
        message.success('更新成功');
      } else if (records.length > 0) {
        for (const record of records) {
          await modelAliasesAPI.create(record);
        }
        message.success(records.length > 1 ? `已添加 ${records.length} 条别名` : '添加成功');
      } else {
        await modelAliasesAPI.create(single);
        message.success('添加成功');
      }
      fetchAliases();
      return true;
    } catch (error: unknown) {
      message.error(errorText(error, '保存失败'));
      return false;
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
    toggleAlias,
    saveAlias
  };
}
