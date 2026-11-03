import { MessageOutlined, FolderOpenOutlined, PlusOutlined, RocketOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import styles from './message-area.module.css';

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
        <div className={`hud-panel ${styles.emptyCardHarmony}`}>
          <div className={styles.emptyIconBadgeHarmony}>
            <RocketOutlined />
          </div>
          <h2 className={styles.emptyTitleHarmony}>AI Home 纯聊天模式</h2>
          <div className={styles.emptyPromptChips}>
            {['💡 构思全栈系统架构', '⚡ 优化高并发流式渲染', '🎨 设计一个数据表格组件', '🔍 审查代码逻辑缺陷'].map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={onCreateSession}
                className={styles.emptyPromptChip}
              >
                {prompt}
              </button>
            ))}
          </div>
          <p className={styles.emptyDescHarmony}>
            保留对话上下文，随时继续之前的话题。<br />
            无需绑定工作目录，专注于思考与创作。
          </p>
          <Button
            type="primary"
            icon={<MessageOutlined />}
            onClick={onCreateSession}
            className={styles.emptyPrimaryBtn}
          >
            发起新对话
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.emptyContainerHarmony}>
      <div className={`hud-panel ${styles.emptyCardHarmony}`}>
        <div className={styles.emptyIconBadgeHarmony}>
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
            className={styles.emptyPrimaryBtn}
          >
            新建工作区会话
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<FolderOpenOutlined />}
            onClick={onOpenProject}
            className={styles.emptyPrimaryBtn}
          >
            打开项目目录
          </Button>
        )}
      </div>
    </div>
  );
}
