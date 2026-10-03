import { useCallback, useState } from 'react';
import { Modal, message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type { ManagedToolItem, ManagedToolServiceAction } from '@/types';
import { toolkitRequestError as requestError } from './request-error';
import { SERVICE_ACTION_LABELS, serviceActionNeedsConfirm } from './tool-service-presentation';

/**
 * 托管工具服务控制的行为层（桌面与移动端共用）：启停/重启、守护策略、新建配置、日志读取。
 * 每次操作成功后回调 onChanged 让列表重新探测。
 */
export function useToolService(onChanged: () => void | Promise<void>) {
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<{ tool: ManagedToolItem; lines: string[]; loading: boolean } | null>(null);

  const withBusy = useCallback(async (tool: ManagedToolItem, label: string, task: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [tool.id]: label }));
    try {
      await task();
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[tool.id];
        return next;
      });
    }
  }, []);

  const execute = useCallback((tool: ManagedToolItem, action: ManagedToolServiceAction) => withBusy(tool, action, async () => {
    try {
      const result = await toolkitAPI.controlToolService(tool.id, action);
      if (!result.ok) throw new Error(result.message || result.error || '服务操作失败');
      message.success(`${tool.name} 已${SERVICE_ACTION_LABELS[action]}`);
    } catch (error: unknown) {
      message.error(requestError(error, `${tool.name}${SERVICE_ACTION_LABELS[action]}失败`));
    }
    await onChanged();
  }), [onChanged, withBusy]);

  const control = useCallback((tool: ManagedToolItem, action: ManagedToolServiceAction) => {
    if (!serviceActionNeedsConfirm(action)) {
      void execute(tool, action);
      return;
    }
    Modal.confirm({
      title: `${SERVICE_ACTION_LABELS[action]} ${tool.name}`,
      content: `${SERVICE_ACTION_LABELS[action]}会中断 ${tool.name} 当前建立的隧道连接，确认继续？`,
      okText: `确认${SERVICE_ACTION_LABELS[action]}`,
      cancelText: '取消',
      okButtonProps: action === 'stop' ? { danger: true } : undefined,
      onOk: () => execute(tool, action)
    });
  }, [execute]);

  const updateSettings = useCallback(
    (tool: ManagedToolItem, settings: { autoStart?: boolean; autoRestart?: boolean }) => withBusy(tool, 'settings', async () => {
      try {
        const result = await toolkitAPI.updateToolServiceSettings(tool.id, settings);
        if (!result.ok) throw new Error(result.message || result.error || '守护策略保存失败');
      } catch (error: unknown) {
        message.error(requestError(error, '守护策略保存失败'));
      }
      await onChanged();
    }),
    [onChanged, withBusy]
  );

  const createConfig = useCallback((tool: ManagedToolItem) => withBusy(tool, 'config', async () => {
    try {
      const result = await toolkitAPI.createToolServiceConfig(tool.id);
      if (!result.ok) throw new Error(result.message || result.error || '新建配置失败');
      message.success('已新建配置模板，请编辑服务器地址与代理后再启动');
    } catch (error: unknown) {
      message.error(requestError(error, '新建配置失败'));
    }
    await onChanged();
  }), [onChanged, withBusy]);

  const openLogs = useCallback(async (tool: ManagedToolItem) => {
    setLogs({ tool, lines: [], loading: true });
    try {
      const result = await toolkitAPI.getToolServiceLogs(tool.id);
      setLogs({ tool, lines: result.lines || [], loading: false });
    } catch (error: unknown) {
      setLogs(null);
      message.error(requestError(error, '读取日志失败'));
    }
  }, []);

  return {
    busyFor: (tool: ManagedToolItem) => busy[tool.id] || '',
    control,
    updateSettings,
    createConfig,
    logs,
    openLogs,
    closeLogs: () => setLogs(null)
  };
}
