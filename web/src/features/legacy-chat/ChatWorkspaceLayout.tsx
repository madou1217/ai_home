import type { ReactNode, TouchEventHandler } from 'react';
import { Layout } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import PageScaffold from '@/components/ui/PageScaffold';
import MobileBackButton from '@/components/mobile/MobileBackButton';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { providerAccentStyle } from '@/components/chat/provider-registry';
import styles from '@/components/chat/chat.module.css';
import type { Session } from '@/types';

type ChatWorkspaceLayoutProps = {
  mobile: boolean;
  mobileShowChat: boolean;
  selectedSession: Session | null;
  sessionRunning: boolean;
  projectLabel: string;
  projectList: ReactNode;
  chatContent: ReactNode;
  dialogs: ReactNode;
  onBack: () => void;
  onCreateSession: () => void;
  onTouchStart: TouchEventHandler<HTMLElement>;
  onTouchEnd: TouchEventHandler<HTMLElement>;
};

function MobileWorkspace(props: ChatWorkspaceLayoutProps) {
  const session = props.selectedSession;
  return (
    <div className={styles.mobileStack}>
      <section className={`${styles.mobileScreen} ${props.mobileShowChat ? styles.mobileScreenBehind : ''}`}>
        <div className={styles.mobileScreenBody}>{props.projectList}</div>
      </section>
      <section
        className={`${styles.mobileScreen} ${styles.mobileScreenChat} ${props.mobileShowChat ? styles.mobileScreenActive : ''}`}
        style={providerAccentStyle(session?.provider)}
        aria-hidden={!props.mobileShowChat}
        onTouchStart={props.onTouchStart}
        onTouchEnd={props.onTouchEnd}
      >
        <header className={styles.mobileNav}>
          <div className={styles.mobileNavSide}>
            <MobileBackButton className={styles.mobileBack} title="返回会话列表" label="会话" onClick={props.onBack} />
          </div>
          <div className={styles.mobileNavCenter}>
            {session?.provider ? (
              <span className={`${styles.mobileNavBadge} ${props.sessionRunning ? styles.mobileNavBadgeRunning : ''}`}>
                <ProviderIcon provider={session.provider} size={16} />
              </span>
            ) : null}
            <span className={styles.mobileNavTitle}>{session?.title || props.projectLabel}</span>
          </div>
          <div className={styles.mobileNavSide}>
            <button type="button" className={styles.mobileNavAction} aria-label="新建会话" onClick={props.onCreateSession}>
              <PlusOutlined />
            </button>
          </div>
        </header>
        <div className={styles.mobileScreenBody}>{props.chatContent}</div>
      </section>
    </div>
  );
}

function DesktopWorkspace(props: ChatWorkspaceLayoutProps) {
  const { Sider, Content } = Layout;
  return (
    <>
      <Sider
        width={280}
        theme="light"
        breakpoint="md"
        collapsedWidth={0}
        style={{ borderRight: '1px solid var(--color-border)', height: '100%', background: 'var(--color-surface-raised)' }}
      >
        {props.projectList}
      </Sider>
      <Content style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {props.chatContent}
      </Content>
    </>
  );
}

export default function ChatWorkspaceLayout(props: ChatWorkspaceLayoutProps) {
  return (
    <PageScaffold title="AI 会话" fullBleed>
      <Layout style={{ height: '100%', background: 'var(--color-bg)', overflow: 'hidden' }}>
        {props.mobile ? <MobileWorkspace {...props} /> : <DesktopWorkspace {...props} />}
        {props.dialogs}
      </Layout>
    </PageScaffold>
  );
}
