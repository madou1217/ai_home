import { useEffect, useRef } from 'react';
import { Modal, Spin } from 'antd';
import type { ManagedToolItem } from '@/types';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';
import { useManagedToolConfig } from './use-managed-tool-config';

interface ManagedToolConfigModalProps {
  /** 要编辑的工具；为空即关闭。 */
  tool: ManagedToolItem | null;
  onClose: () => void;
  /** 保存/重启成功后回调（调用方刷新工具列表）。 */
  onSaved?: () => void | Promise<void>;
}

/**
 * 受管工具的配置文件编辑器（桌面）：读取 → 编辑 → **服务端校验后保存** → 可选「保存并重启」。
 * 行为层在 useManagedToolConfig（与移动端弹层共用），这里只负责桌面渲染。
 */
export default function ManagedToolConfigModal({ tool, onClose, onSaved }: ManagedToolConfigModalProps) {
  const { configData, content, setContent, loading, saving, error, save } = useManagedToolConfig(tool, onSaved);
  const reportedError = useRef('');
  const toolId = tool?.id || '';

  // 读取失败（例如配置目标不可读）时把面板关掉：错误已经通过 message 提示过。
  useEffect(() => {
    if (!error || !toolId) return;
    if (reportedError.current === `${toolId}:${error}`) return;
    reportedError.current = `${toolId}:${error}`;
    if (!configData) onClose();
  }, [error, configData, toolId, onClose]);

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
