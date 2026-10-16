import { useCallback, useEffect, useState } from 'react';
import { Modal, Spin, message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type { ManagedToolItem, ToolkitToolConfigResponse } from '@/types';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';
import { toolkitRequestError as requestError } from './request-error';

interface ManagedToolConfigModalProps {
  /** 要编辑的工具；为空即关闭。 */
  tool: ManagedToolItem | null;
  onClose: () => void;
  /** 保存/重启成功后回调（调用方刷新工具列表）。 */
  onSaved?: () => void;
}

/**
 * 受管工具的配置文件编辑器（应用管理、终端管理、入口与转发共用同一实现）：
 * 读取 → 编辑 → **服务端校验后保存**（并发修改用 revision 兜底）→ 可选「保存并重启」。
 */
export default function ManagedToolConfigModal({ tool, onClose, onSaved }: ManagedToolConfigModalProps) {
  const [configData, setConfigData] = useState<ToolkitToolConfigResponse | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const toolId = tool?.id || '';

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setConfigData(null);
    setContent('');
    try {
      const result = await toolkitAPI.getToolConfig(id);
      if (!result.ok) throw new Error('工具配置接口未返回可用结果');
      setConfigData(result);
      setContent(result.content || '');
    } catch (error: unknown) {
      message.error(requestError(error, '读取工具配置失败'));
      onClose();
    } finally {
      setLoading(false);
    }
  }, [onClose]);

  useEffect(() => {
    if (!toolId) return;
    void load(toolId);
  }, [toolId, load]);

  const save = useCallback(async (restartAfter = false) => {
    if (!tool || !configData) return;
    setSaving(true);
    try {
      const result = await toolkitAPI.saveToolConfig(tool.id, content, configData.revision, configData.targetRevision);
      if (!result.ok) throw new Error('工具配置保存接口返回失败');
      setConfigData(result);
      message.success(result.elevated ? '配置已通过系统授权保存' : '配置已保存');
      if (restartAfter) {
        const restarted = await toolkitAPI.controlToolService(tool.id, 'restart');
        if (!restarted.ok) throw new Error(restarted.message || '配置已保存，但重启失败');
        message.success(`${tool.name} 已按新配置重启`);
      }
      onSaved?.();
    } catch (error: unknown) {
      message.error(requestError(error, restartAfter ? '保存并重启失败' : '保存工具配置失败'));
    } finally {
      setSaving(false);
    }
  }, [tool, configData, content, onSaved]);

  return (
    <Modal
      open={Boolean(tool)}
      onCancel={onClose}
      width={1000}
      title={tool ? `${tool.name} 配置` : '配置'}
      footer={(
        <div className="toolkit-header-actions">
          <Button onClick={onClose}>关闭</Button>
          {tool?.service?.canRestart ? (
            <Button loading={saving} disabled={!configData || loading} onClick={() => void save(true)}>
              保存并重启
            </Button>
          ) : null}
          <Button
            type="primary"
            loading={saving}
            disabled={!configData || loading}
            onClick={() => void save()}
          >
            保存
          </Button>
        </div>
      )}
    >
      {loading ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取配置" /></div>
      ) : (
        <>
          <p className="toolkit-section-note">
            配置可能包含敏感信息；
            {configData?.requiresElevation
              ? '当前目标需要系统授权才能保存，接口不会返回绝对路径。'
              : `格式为 ${configData?.configFormat || tool?.configFormat || 'text'}，保存时会校验并发修改。`}
          </p>
          {configData && !configData.writable ? (
            <InlineNote tone="warning">当前配置不可写（或需要系统授权），保存时可能被拒绝。</InlineNote>
          ) : null}
          <ConfigCodeEditor
            value={content}
            onChange={setContent}
            format={configData?.configFormat || tool?.configFormat}
            fileName={configData?.configName || tool?.configName}
            ariaLabel={`${tool?.name || '工具'} 配置内容`}
            onSave={saving ? undefined : () => void save()}
          />
        </>
      )}
    </Modal>
  );
}
