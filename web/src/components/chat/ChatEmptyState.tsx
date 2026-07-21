import { Empty } from 'antd';
import { FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';

interface Props {
  readonly projectPath?: string;
  readonly mobile?: boolean;
  readonly onCreateSession: () => void;
  readonly onOpenProject: () => void;
}

export default function ChatEmptyState({
  projectPath,
  mobile = false,
  onCreateSession,
  onOpenProject,
}: Props) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-bg)', padding: mobile ? 20 : 32,
    }}>
      <Empty
        description={projectPath ? `项目：${projectPath}` : '先打开一个项目，或从左上角展开项目列表'}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        {projectPath ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateSession}>新建会话</Button>
        ) : (
          <Button type="primary" icon={<FolderOpenOutlined />} onClick={onOpenProject}>打开项目</Button>
        )}
      </Empty>
    </div>
  );
}
