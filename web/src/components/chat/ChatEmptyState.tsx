import { MessageOutlined, FolderOpenOutlined, PlusOutlined, RocketOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import styles from './chat.module.css';

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
  onCreateSession,
  onOpenProject,
}: Props) {
  if (mode === 'chat') {
    return (
      <div className={styles.emptyContainerHarmony}>
        <div className={styles.emptyCardHarmony}>
          <div className={styles.emptyIconBadgeHarmony}>
            <RocketOutlined />
          </div>
          <h2 className={styles.emptyTitleHarmony}>AI Home 纯聊天模式</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', margin: '16px 0 20px', maxWidth: 440 }}>
            {['💡 构思全栈系统架构', '⚡ 优化高并发流式渲染', '🎨 设计鸿蒙亚克力质感组件', '🔍 审查代码逻辑缺陷'].map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={onCreateSession}
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--hos-radius-pill, 9999px)',
                  border: '0.8px solid rgba(10, 89, 247, 0.2)',
                  background: 'rgba(255, 255, 255, 0.7)',
                  backdropFilter: 'blur(12px)',
                  color: '#1e293b',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.14s ease',
                  boxShadow: '0 2px 6px rgba(0, 0, 0, 0.02)'
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
          <p className={styles.emptyDescHarmony}>
            直接面向集中 API 网关，毫秒级即时连接。<br />
            无需绑定工作目录，专注于思考与创作。
          </p>
          <Button
            type="primary"
            icon={<MessageOutlined />}
            onClick={onCreateSession}
            style={{
              height: 42,
              padding: '0 24px',
              borderRadius: 'var(--hos-radius-pill, 9999px)',
              fontSize: 15,
              fontWeight: 500,
              background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)',
              boxShadow: '0 8px 24px -4px rgba(37, 99, 235, 0.35)',
              border: 'none',
            }}
          >
            发起新对话
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.emptyContainerHarmony}>
      <div className={styles.emptyCardHarmony}>
        <div className={styles.emptyIconBadgeHarmony} style={{ color: '#0d9488', background: 'rgba(13, 148, 136, 0.12)' }}>
          <FolderOpenOutlined />
        </div>
        <h2 className={styles.emptyTitleHarmony}>
          {projectPath ? '工作区项目就绪' : 'Work 工作区工程模式'}
        </h2>
        <p className={styles.emptyDescHarmony}>
          {projectPath ? (
            <>项目路径：<code>{projectPath}</code><br />支持本地工程文件树、Git Review 与交互终端。</>
          ) : (
            <>挂载本地项目目录，激活完整 Agent 工程流、计划审批与 PTY 终端能力。</>
          )}
        </p>
        {projectPath ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onCreateSession}
            style={{
              height: 42,
              padding: '0 24px',
              borderRadius: 'var(--hos-radius-pill, 9999px)',
              fontSize: 15,
              fontWeight: 500,
              background: 'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)',
              boxShadow: '0 8px 24px -4px rgba(13, 148, 136, 0.35)',
              border: 'none',
            }}
          >
            新建工作区会话
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<FolderOpenOutlined />}
            onClick={onOpenProject}
            style={{
              height: 42,
              padding: '0 24px',
              borderRadius: 'var(--hos-radius-pill, 9999px)',
              fontSize: 15,
              fontWeight: 500,
              background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)',
              boxShadow: '0 8px 24px -4px rgba(37, 99, 235, 0.35)',
              border: 'none',
            }}
          >
            打开项目目录
          </Button>
        )}
      </div>
    </div>
  );
}
