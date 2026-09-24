import { useEffect, useRef, useState } from 'react';
import { Input, Spin } from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { imageStudioAssetKey } from '@/features/image-studio/image-studio-utils';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
} from '@/mobile/ui';
import type { ImageStudioSessionSummary } from '@/types';
import type { MobilePageProps } from '../mobile-routes';
import StudioCanvas from './studio/StudioCanvas';
import StudioComposer from './studio/StudioComposer';
import StudioRevisionGallery from './studio/StudioRevisionGallery';
import { useMobileImageStudio, type MobileImageStudio } from './studio/use-mobile-image-studio';
import styles from './MobileStudio.module.css';

function statusLabel(status: ImageStudioSessionSummary['latestStatus']) {
  if (status === 'running') return { text: '处理中', tone: 'info' };
  if (status === 'failed') return { text: '需处理', tone: 'err' };
  if (status === 'succeeded') return { text: '已出片', tone: 'ok' };
  return { text: '空会话', tone: 'muted' };
}

function ModelsReadout({ studio }: { studio: MobileImageStudio }) {
  const online = studio.models.filter((model) => model.availableAccountCount > 0).length;
  return (
    <span className="mhud-status">
      <span className={`hud-led ${online > 0 ? 'hud-led--ok' : 'hud-led--warn'}`} aria-hidden="true" />
      {online}/{studio.models.length} MODELS ONLINE
    </span>
  );
}

/** 灵感工坊（/studio/image）移动端：会话列表 → 沉浸式会话视图（画布 + 修订 + 拇指区控制台）。 */
export default function MobileStudio(_props: MobilePageProps) {
  const studio = useMobileImageStudio();

  if (studio.initializing) return <MobileBoot label="LOADING STUDIO" />;
  if (studio.requestedSessionId) return <SessionView studio={studio} />;

  return (
    <MobilePage
      toolbar={(
        <MobileToolbar start={<ModelsReadout studio={studio} />}>
          <HudIconButton icon={<ReloadOutlined />} label="刷新会话" loading={studio.refreshingList} onClick={() => void studio.refreshList()} />
          <HudIconButton icon={<PlusOutlined />} label="新会话" tone="primary" showLabel onClick={() => void studio.createSession()} />
        </MobileToolbar>
      )}
    >
      {studio.initError ? (
        <div className={styles.error} role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <span>影像工作台初始化失败：{studio.initError}</span>
        </div>
      ) : null}
      <HudSection title="会话胶片" code="SESSION FILM" count={studio.sessions.length}>
        {studio.sessions.length ? (
          <MonoList ariaLabel="影像会话">
            {studio.sessions.map((item, index) => {
              const previewUrl = item.previewAssetId ? studio.assetUrls[imageStudioAssetKey(item.id, item.previewAssetId)] : '';
              const status = statusLabel(item.latestStatus);
              return (
                <SwipeRow key={item.id} onTap={() => studio.openSession(item.id)} ariaLabel={`打开 ${item.title}`}>
                  <span className={styles.sessionThumb}>
                    {previewUrl ? <img src={previewUrl} alt="" /> : <span>{String(index + 1).padStart(2, '0')}</span>}
                  </span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{item.title}</span>
                    <span className="mhud-row__meta">{item.revisionCount} 次修订 · {item.latestModel || '等待首个镜头'}</span>
                  </span>
                  <span className="mhud-row__side">
                    <span className={`mhud-status mhud-tone--${status.tone}`}>{status.text}</span>
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        ) : (
          <EmptySignal
            description="还没有影像会话。新建会话后选择模型、写下画面意图即可生成第一帧。"
            action={<HudIconButton icon={<PictureOutlined />} label="新建会话" tone="primary" showLabel onClick={() => void studio.createSession()} />}
          />
        )}
      </HudSection>
    </MobilePage>
  );
}

function SessionView({ studio }: { studio: MobileImageStudio }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const { session } = studio;

  useEffect(() => {
    document.body.dataset.mobileImmersive = '1';
    return () => {
      delete document.body.dataset.mobileImmersive;
    };
  }, []);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <HudIconButton icon={<ArrowLeftOutlined />} label="返回会话列表" onClick={studio.closeSession} />
        <div className={styles.headerTitles}>
          <span className={styles.headerCode}>IMG/ STUDIO</span>
          <span className={styles.headerTitle}>{session?.title || '影像会话'}</span>
        </div>
        {studio.switchingSession ? <Spin size="small" /> : null}
        <HudIconButton icon={<ReloadOutlined />} label="刷新会话" disabled={!session || studio.running} onClick={() => void studio.refreshCurrent()} />
        <HudIconButton
          icon={<MoreOutlined />}
          label="会话操作"
          disabled={!session}
          onClick={() => {
            setRenameValue(session?.title || '');
            setMoreOpen(true);
          }}
        />
      </header>

      <div className={styles.scroll} ref={scrollRef}>
        {session ? (
          <>
            <StudioCanvas studio={studio} />
            <StudioRevisionGallery studio={studio} onSelected={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
          </>
        ) : (
          <MobileBoot label="LOADING SESSION" />
        )}
      </div>

      {session ? <StudioComposer studio={studio} /> : null}

      <DetailSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        code="SESSION"
        title={session?.title || '影像会话'}
        footer={(
          <button
            type="button"
            className={`${styles.button} ${styles.buttonDanger}`}
            disabled={!session || studio.sessionHasRunningRevision}
            onClick={() => {
              setMoreOpen(false);
              studio.confirmDeleteSession();
            }}
          >
            <DeleteOutlined />
            <span>{studio.sessionHasRunningRevision ? '运行中的会话不能删除' : '删除当前会话'}</span>
          </button>
        )}
      >
        <div className={styles.params}>
          <ModelsReadout studio={studio} />
          <label className={styles.renameLabel} htmlFor="mobile-studio-rename">重命名影像会话</label>
          <div className={styles.renameRow}>
            <Input id="mobile-studio-rename" value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} />
            <HudIconButton
              icon={<SaveOutlined />}
              label="保存"
              tone="primary"
              disabled={!renameValue.trim()}
              onClick={async () => {
                const ok = await studio.renameSession(renameValue);
                if (ok) setMoreOpen(false);
              }}
            />
          </div>
        </div>
      </DetailSheet>
    </div>
  );
}
