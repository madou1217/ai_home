import { Modal } from 'antd';

export type AccountAppInstallKind = 'desktop' | 'cli';

interface AccountAppInstallModalProps {
  open: boolean;
  providerName: string;
  kind: AccountAppInstallKind;
  message: string;
  confirmLoading: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

function getClientLabel(kind: AccountAppInstallKind) {
  return kind === 'desktop' ? 'Desktop 应用' : '原生 CLI';
}

/** 账号页只负责确认语义，实际安装由 Toolkit 应用管理任务接管。 */
export function AccountAppInstallModal({
  open,
  providerName,
  kind,
  message,
  confirmLoading,
  onConfirm,
  onCancel,
}: AccountAppInstallModalProps) {
  const clientLabel = getClientLabel(kind);

  return (
    <Modal
      open={open}
      title={`未检测到 ${providerName} ${clientLabel}`}
      okText="确认安装"
      cancelText="取消"
      confirmLoading={confirmLoading}
      destroyOnHidden
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <div className="account-app-install-copy">
        <p>{message || `当前主机尚未安装 ${clientLabel}。`}</p>
        <p className="account-app-install-copy__hint">
          确认后将由 Toolkit &gt;
          应用管理创建异步安装任务，进度会显示在右下角任务队列。
        </p>
      </div>
    </Modal>
  );
}
