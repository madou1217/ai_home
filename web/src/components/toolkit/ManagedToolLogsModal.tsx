import { Modal } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ManagedToolItem } from '@/types';
import Button from '@/components/ui/AppButton';

export interface ManagedToolLogsState {
  tool: ManagedToolItem;
  lines: string[];
  loading: boolean;
}

interface ManagedToolLogsModalProps {
  logs: ManagedToolLogsState | null;
  onReload: (tool: ManagedToolItem) => void;
  onClose: () => void;
}

/** 服务日志弹窗（受管工具共用）：只展示服务端回传的真实日志行。 */
export default function ManagedToolLogsModal({ logs, onReload, onClose }: ManagedToolLogsModalProps) {
  return (
    <Modal
      open={Boolean(logs)}
      title={logs ? `${logs.tool.name} 最近日志` : '日志'}
      width={1000}
      destroyOnHidden
      footer={(
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} onClick={() => logs && onReload(logs.tool)}>重新读取</Button>
          <Button type="primary" onClick={onClose}>关闭</Button>
        </div>
      )}
      onCancel={onClose}
    >
      <div className="toolkit-tool-config" role="log" aria-live="polite" aria-busy={logs?.loading || undefined}>
        {logs?.loading ? <p className="toolkit-section-note">正在读取日志…</p> : null}
        <pre tabIndex={0}><code>{logs?.lines.length ? logs.lines.join('\n') : '暂无日志输出'}</code></pre>
      </div>
    </Modal>
  );
}
