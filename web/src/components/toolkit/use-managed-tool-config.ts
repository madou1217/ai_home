import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type { ManagedToolItem, ToolkitToolConfigResponse } from '@/types';
import { toolkitRequestError as requestError } from './request-error';

/**
 * 受管工具配置编辑的**行为层**（桌面弹窗与移动端底部弹层共用）：
 * 读取 → 编辑 → 服务端校验后保存（revision 兜底并发修改）→ 可选「保存并重启」。
 * 渲染各端自己决定（桌面 Monaco、移动端轻量文本框），流程只有这一份。
 */
export function useManagedToolConfig(tool: ManagedToolItem | null, onSaved?: () => void | Promise<void>) {
  const [configData, setConfigData] = useState<ToolkitToolConfigResponse | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toolId = tool?.id || '';

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setConfigData(null);
    setContent('');
    setError('');
    try {
      const result = await toolkitAPI.getToolConfig(id);
      if (!result.ok) throw new Error('工具配置接口未返回可用结果');
      setConfigData(result);
      setContent(result.content || '');
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取工具配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!toolId) {
      setConfigData(null);
      setContent('');
      setError('');
      return;
    }
    void load(toolId);
  }, [toolId, load]);

  const save = useCallback(async (restartAfter = false) => {
    if (!tool || !configData) return false;
    setSaving(true);
    setError('');
    try {
      const result = await toolkitAPI.saveToolConfig(tool.id, content, configData.revision, configData.targetRevision);
      if (!result.ok) throw new Error('工具配置保存接口返回失败');
      setConfigData({ ...configData, ...result, content });
      message.success(result.elevated ? '配置已通过系统授权保存' : '配置已保存');
      if (restartAfter) {
        const restarted = await toolkitAPI.controlToolService(tool.id, 'restart');
        if (!restarted.ok) throw new Error(restarted.message || '配置已保存，但重启失败');
        message.success(`${tool.name} 已按新配置重启`);
      }
      await onSaved?.();
      return true;
    } catch (requestFailure: unknown) {
      const detail = requestError(requestFailure, restartAfter ? '保存并重启失败' : '保存工具配置失败');
      setError(detail);
      message.error(detail);
      return false;
    } finally {
      setSaving(false);
    }
  }, [tool, configData, content, onSaved]);

  return {
    configData,
    content,
    setContent,
    loading,
    saving,
    error,
    reload: () => (toolId ? load(toolId) : Promise.resolve()),
    save
  };
}
