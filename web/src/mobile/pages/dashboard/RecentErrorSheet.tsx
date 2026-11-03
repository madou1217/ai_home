import { Button } from 'antd';
import { CopyOutlined, MessageOutlined } from '@ant-design/icons';
import {
  describeErrorPipeline,
  extractProjectBasename,
  formatSessionShortId,
  type DashboardRecentError
} from '@/features/dashboard/dashboard-presentation';
import { DetailSheet, KeyValue } from '@/mobile/ui';
import styles from '../MobileDashboard.module.css';

export interface RecentErrorView {
  key: string;
  item: DashboardRecentError;
  account: string;
  text: string;
}

interface Props {
  open: boolean;
  error: RecentErrorView | null;
  onClose: () => void;
  onCopy: (text: string) => void;
  onOpenChat: (options: { projectPath?: string; sessionId?: string }) => void;
}

/** 最近错误详情：错误正文 + 调用链路 / 别名映射 / 项目 / 会话 / 路由（字段与桌面错误卡一致）。 */
export default function RecentErrorSheet({ open, error, onClose, onCopy, onOpenChat }: Props) {
  if (!error) return null;
  const { item, account, text } = error;
  const pipeline = describeErrorPipeline(item);
  const canOpenChat = Boolean(item.projectPath || item.sessionId);
  const rows = [
    { key: 'account', label: '账号', value: account, mono: false },
    item.at ? { key: 'at', label: '时间', value: new Date(item.at).toLocaleString() } : null,
    pipeline.isCrossRoute
      ? { key: 'route-chain', label: '链路', value: `${pipeline.sourceProtocolLabel || item.familyProvider?.toUpperCase() || ''} → ${pipeline.targetProviderLabel}` }
      : pipeline.targetProviderLabel
        ? { key: 'provider', label: 'Provider', value: pipeline.targetProviderLabel }
        : null,
    pipeline.isAlias && pipeline.displayRequestedModel && pipeline.displayEffectiveModel
      ? { key: 'alias', label: '模型映射', value: `${pipeline.displayRequestedModel} → ${pipeline.displayEffectiveModel}` }
      : item.model
        ? { key: 'model', label: '模型', value: item.model }
        : null,
    item.projectPath
      ? { key: 'project', label: '项目', value: extractProjectBasename(item.projectPath, item.projectDirName) }
      : null,
    item.sessionId ? { key: 'session', label: '会话', value: formatSessionShortId(item.sessionId) } : null,
    item.route && item.route !== '/v1/chat/completions' ? { key: 'route', label: '路由', value: item.route } : null
  ].filter((row): row is NonNullable<typeof row> => Boolean(row));

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="ERROR"
      title={account}
      footer={(
        <>
          <Button icon={<CopyOutlined />} onClick={() => onCopy(text)}>复制错误详情</Button>
          {canOpenChat ? (
            <Button
              type="primary"
              icon={<MessageOutlined />}
              onClick={() => onOpenChat({ projectPath: item.projectPath, sessionId: item.sessionId })}
            >
              {item.sessionId ? '打开会话' : '打开项目'}
            </Button>
          ) : null}
        </>
      )}
    >
      <p className={styles.errorText}>{text}</p>
      <KeyValue rows={rows} />
    </DetailSheet>
  );
}
