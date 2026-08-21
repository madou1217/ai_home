import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { Modal } from 'antd';
import type { AppInstallJob } from '@/types';
import { getAppInstallFailureReasons } from '@/features/app-install/app-install-presentation';
import type { AccountAppInstallKind } from './AccountAppInstallModal';
import './AccountAppInstallResultModal.css';

interface AccountAppInstallResultModalProps {
  open: boolean;
  providerName: string;
  accountLabel: string;
  kind: AccountAppInstallKind;
  job: AppInstallJob | null;
  error?: string;
  onOpenApp: () => void;
  onRetry: () => void;
  onClose: () => void;
}

function clientLabel(kind: AccountAppInstallKind) {
  return kind === 'desktop' ? 'Desktop 应用' : '原生 CLI';
}

/** 账号页安装终态只负责结果与下一步选择，不再隐式替用户启动应用。 */
export function AccountAppInstallResultModal({
  open,
  providerName,
  accountLabel,
  kind,
  job,
  error,
  onOpenApp,
  onRetry,
  onClose
}: AccountAppInstallResultModalProps) {
  const succeeded = job?.status === 'succeeded';
  const reasons = succeeded
    ? []
    : job
      ? getAppInstallFailureReasons(job)
      : [String(error || '安装任务未返回失败原因').trim()];

  return (
    <Modal
      open={open}
      title={succeeded ? '安装成功' : '安装失败'}
      okText={succeeded ? '用此账号打开' : '重新安装'}
      cancelText={succeeded ? '稍后' : '关闭'}
      destroyOnHidden
      onOk={succeeded ? onOpenApp : onRetry}
      onCancel={onClose}
    >
      <div className={`account-app-install-result is-${succeeded ? 'success' : 'error'}`}>
        <div className="account-app-install-result__status" role={succeeded ? 'status' : 'alert'}>
          {succeeded ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          <div>
            <strong>{providerName} {clientLabel(kind)}{succeeded ? '已安装' : '未安装成功'}</strong>
            <span>
              {succeeded
                ? '可以立即使用当前账号打开，也可以稍后在应用管理中选择其他账号。'
                : '任务已经停止，下面保留了服务端返回的失败原因。'}
            </span>
          </div>
        </div>
        <dl className="account-app-install-result__metadata">
          <div><dt>账号</dt><dd>{accountLabel}</dd></div>
          <div><dt>客户端</dt><dd>{clientLabel(kind)}</dd></div>
          {job?.finishedAt ? <div><dt>完成时间</dt><dd>{new Date(job.finishedAt).toLocaleString()}</dd></div> : null}
        </dl>
        {reasons.length ? (
          <div className="account-app-install-result__reasons">
            <strong>失败原因</strong>
            <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
