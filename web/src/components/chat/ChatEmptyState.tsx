import { Empty } from 'antd';
import { FolderOpenOutlined, MessageOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';

interface Props {
  readonly mode?: 'chat' | 'work';
  readonly projectPath?: string;
  readonly mobile?: boolean;
  readonly onCreateSession: () => void;
  readonly onOpenProject: () => void;
}

export default function ChatEmptyState({
  mode = 'work',
  projectPath,
  mobile = false,
  onCreateSession,
  onOpenProject,
}: Props) {
  if (mode === 'chat') {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--color-bg)', padding: mobile ? 20 : 32,
      }}>
        <Empty
          description="纯聊天模式：通过 AI Home 集中网关快速对话，无需绑定本地工作目录"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" icon={<MessageOutlined />} onClick={onCreateSession}>
            发起新对话
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--color-bg)', padding: mobile ? 20 : 32,
    }}>
      <Empty
        description={projectPath ? `工作区项目：${projectPath}` : 'Work 模式：请先打开项目目录，或从左侧展开已有项目'}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        {projectPath ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateSession}>新建工作区会话</Button>
        ) : (
          <Button type="primary" icon={<FolderOpenOutlined />} onClick={onOpenProject}>打开项目</Button>
        )}
      </Empty>
    </div>
  );
}
