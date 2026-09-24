import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { getSessionRunKey, isSameSession } from '@/components/chat/project-runtime-state.js';
import { getProviderLabel, providerAccentStyle } from '@/components/chat/provider-registry';
import {
  archivedSessionTime,
  canUnarchiveSession,
} from '@/components/chat/session-lifecycle-policy.js';
import { lifecycleErrorMessage } from '@/components/chat/useSessionLifecycle';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudIconButton, MonoList, SwipeRow } from '@/mobile/ui';
import { sessionsAPI } from '@/services/api';
import type { ArchivedSession } from '@/types';
import { confirmAction } from '@/utils/confirm-action';
import styles from './mobile-chat.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 还原成功后刷新项目目录（与桌面 ArchivedDrawer.onRestored 相同） */
  onRestored: () => void;
}

/**
 * 已归档会话：与桌面 ArchivedDrawer 同一组 API（getArchivedSessions / unarchiveSession）、
 * 同样的部分失败提示与还原确认，只是换成底部 HUD 抽屉 + 等宽列表。
 */
export default function ArchivedSessionsSheet({ open, onClose, onRestored }: Props) {
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadArchived = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sessionsAPI.getArchivedSessions();
      setSessions(result.archived);
      setFailed(false);
      if (result.errors.length > 0) {
        message.warning(`部分原生归档加载失败：${result.errors.map((error) => error.provider).join('、')}`);
      }
    } catch (error) {
      setFailed(true);
      message.error(lifecycleErrorMessage(error, '加载归档列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadArchived();
  }, [loadArchived, open]);

  const restore = async (session: ArchivedSession) => {
    const ok = await confirmAction({
      title: '还原此会话？',
      content: '还原后会话将重新出现在项目列表中',
      okText: '确定',
    });
    if (!ok) return;
    try {
      await sessionsAPI.unarchiveSession(session.provider, session.id, session.origin);
      message.success('已还原');
      setSessions((previous) => previous.filter((candidate) => !isSameSession(candidate, session)));
      onRestored();
    } catch (error) {
      message.error(lifecycleErrorMessage(error, '还原失败'));
    }
  };

  let body;
  if (loading && sessions.length === 0) {
    body = <MobileBoot label="SYNC" />;
  } else if (failed && sessions.length === 0) {
    body = (
      <div className={styles.errorLine} role="alert">
        <span className="hud-led hud-led--err" aria-hidden="true" />
        <span className={styles.errorText}>加载归档列表失败</span>
        <HudIconButton icon={<ReloadOutlined />} label="重试" showLabel onClick={() => { void loadArchived(); }} />
      </div>
    );
  } else if (sessions.length === 0) {
    body = <EmptySignal title="NO ARCHIVE" description="暂无归档会话" />;
  } else {
    body = (
      <MonoList ariaLabel="已归档的会话">
        {sessions.map((session) => {
          const restorable = canUnarchiveSession(session);
          return (
            <SwipeRow
              key={getSessionRunKey(session)}
              actions={restorable ? [{
                key: 'restore',
                label: '还原',
                icon: <UndoOutlined />,
                tone: 'primary',
                onAction: () => { void restore(session); },
              }] : []}
            >
              <span className={`mhud-row__icon ${styles.providerSlot}`} style={providerAccentStyle(session.provider)}>
                <ProviderIcon provider={session.provider} size={18} />
              </span>
              <div className="mhud-row__main">
                <span className="mhud-row__title">{session.title}</span>
                <span className="mhud-row__meta">
                  {getProviderLabel(session.provider)} · {session.origin === 'native' ? '原生归档' : '历史归档'}
                </span>
              </div>
              <div className="mhud-row__side">
                <span className={styles.time}>{dayjs(archivedSessionTime(session)).fromNow()}</span>
                {restorable ? (
                  <button type="button" className={styles.inlineAction} onClick={(event) => { event.stopPropagation(); void restore(session); }}>
                    <UndoOutlined /> 还原
                  </button>
                ) : null}
              </div>
            </SwipeRow>
          );
        })}
      </MonoList>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      code="ARCHIVE"
      title="已归档的会话"
      footer={(
        <div className={styles.sheetPrimary}>
          <HudIconButton
            icon={<ReloadOutlined />}
            label="刷新归档列表"
            showLabel
            loading={loading}
            onClick={() => { void loadArchived(); }}
          />
        </div>
      )}
    >
      {body}
    </DetailSheet>
  );
}
