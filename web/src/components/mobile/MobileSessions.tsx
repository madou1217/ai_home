import { useState, useEffect, useRef } from 'react';
import { history } from '@umijs/max';
import {
  PlusOutlined, FolderOpenOutlined, InboxOutlined, ReloadOutlined, FolderOutlined, LoadingOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { AggregatedProject, Session } from '@/types';
import { sessionsAPI } from '@/services/api';
import ProviderIcon from '../chat/ProviderIcon';
import MobileBackButton from './MobileBackButton';
import {
  isSessionRunning, getRunningProviders, getVisibleProjectSessions
} from '../chat/project-runtime-state.js';
import { getProviderLabel } from '../chat/provider-registry';
import './mobile-sessions.css';

dayjs.extend(relativeTime);

interface Props {
  projects: AggregatedProject[];
  loading: boolean;
  hydratingProjectPaths?: Set<string>;
  runningSessionKeys: Set<string>;
  selectedSession: Session | null;
  expandedProjects: Set<string>; // kept for API compat; accordion state is owned locally (see openPath)
  onToggleProject: (project: AggregatedProject) => void;
  onSelectSession: (session: Session) => void;
  onCreateSession: () => void;
  onOpenProject: () => void;
  onOpenArchived: () => void;
  onRefresh: () => void;
  canCreate: boolean;
  onRequestArchiveSession: (session: Session) => void;
  onRequestRemoveProject: (project: AggregatedProject) => void;
}

const COLLAPSED_LIMIT = 10;
const LONG_PRESS_MS = 500;

const Chevron = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
);
const MobileSessions = ({
  projects, loading, hydratingProjectPaths = new Set(), runningSessionKeys, selectedSession,
  onToggleProject, onSelectSession, onCreateSession, onOpenProject, onOpenArchived,
  onRefresh, canCreate, onRequestArchiveSession, onRequestRemoveProject
}: Props) => {
  // Accordion state is LOCAL and one-open-at-a-time — decoupled from Chat's
  // `expandedProjects`, whose selection logic re-applies on every SSE snapshot
  // and was auto-expanding groups. This keeps the list stable/no-flash on data ticks.
  //
  // Identity is the project PATH, not `project.id`: the aggregated id from the
  // backend (webui-project-cache) is the *first-encountered provider's* id, so a
  // multi-provider project's id flips between snapshots when provider iteration
  // order changes — that flip was collapsing/remounting the open drawer on every
  // watch tick. `path` is the aggregation map key and is stable across snapshots.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, { model?: string; preview?: string }>>({});
  const fetchedRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Full-screen list (like the mockup) — hide the global bottom TabBar while mounted.
  useEffect(() => {
    document.body.setAttribute('data-mobile-sessions', '1');
    return () => document.body.removeAttribute('data-mobile-sessions');
  }, []);

  const sortSessions = (list: Session[]): Session[] => [...list].sort((a, b) => {
    const ra = isSessionRunning(a, runningSessionKeys) ? 1 : 0;
    const rb = isSessionRunning(b, runningSessionKeys) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const projectActivity = (p: AggregatedProject) => Math.max(0, ...p.sessions.map((s) => s.updatedAt || 0));
  const projectHasRunning = (p: AggregatedProject) => p.sessions.some((s) => isSessionRunning(s, runningSessionKeys));
  const orderedProjects = [...projects].sort((a, b) => {
    const ra = projectHasRunning(a) ? 1 : 0;
    const rb = projectHasRunning(b) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return projectActivity(b) - projectActivity(a);
  });

  const toggleShowAll = (id: string) => {
    setShowAll((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Lazy previews for the sessions of the currently-open group only.
  useEffect(() => {
    if (!openPath) return;
    const project = projects.find((p) => p.path === openPath);
    if (!project) return;
    const visible = getVisibleProjectSessions(
      sortSessions(project.sessions), true, showAll.has(openPath), COLLAPSED_LIMIT, project.sessions.length
    ) as Session[];
    const toFetch = visible
      .filter((s) => !fetchedRef.current.has(s.id))
      .map((s) => { fetchedRef.current.add(s.id); return { provider: s.provider, id: s.id, projectDirName: s.projectDirName }; });
    if (toFetch.length === 0) return;
    sessionsAPI.getSessionPreviews(toFetch)
      .then((res) => {
        if (!mountedRef.current || !res || Object.keys(res).length === 0) return;
        setPreviews((prev) => ({ ...prev, ...res }));
      })
      .catch(() => {});
  }, [projects, openPath, showAll]);

  const goBack = () => {
    try { if (window.history.length > 1) { history.back(); return; } } catch (_e) { /* noop */ }
    history.push('/dashboard');
  };

  const startLongPress = (project: AggregatedProject) => {
    longPressedRef.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressedRef.current = true;
      try { (navigator as any).vibrate?.(12); } catch (_e) { /* noop */ }
      onRequestRemoveProject(project);
    }, LONG_PRESS_MS);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const handleProjectTap = (project: AggregatedProject) => {
    if (longPressedRef.current) { longPressedRef.current = false; return; } // swallow the tap that ended a long-press
    setOpenPath((prev) => (prev === project.path ? null : project.path));
    onToggleProject(project); // selection side-effect (enables + new session)
  };

  return (
    <div className="msx">
      <div className="msx-head">
        <MobileBackButton className="msx-iconbtn back" onClick={goBack} />
        <h1>会话</h1>
        <button className="msx-iconbtn" title="刷新" onClick={onRefresh} disabled={loading}>
          <ReloadOutlined spin={loading} />
        </button>
        <button className="msx-iconbtn" title="已归档" onClick={onOpenArchived}>
          <InboxOutlined />
        </button>
        <button className="msx-iconbtn" title="打开项目" onClick={onOpenProject}>
          <FolderOpenOutlined />
        </button>
        <button className="msx-iconbtn primary" title="新建会话" onClick={onCreateSession} disabled={!canCreate}>
          <PlusOutlined />
        </button>
      </div>

      <div className="msx-list">
        {loading && projects.length === 0 ? (
          <div className="msx-skel">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="msx-skel-row" />)}
          </div>
        ) : projects.length === 0 ? (
          <div className="msx-empty">
            <div className="big">📁</div>
            暂无项目 · 点击右上角打开一个项目
          </div>
        ) : (
          orderedProjects.map((project) => {
            const isOpen = openPath === project.path;
            const runningProviders = getRunningProviders(project.sessions, runningSessionKeys);
            const runCount = project.sessions.filter((s) => isSessionRunning(s, runningSessionKeys)).length;
            const isShowAll = showAll.has(project.path);
            const isHydratingSessions = hydratingProjectPaths.has(project.path);
            const visible = getVisibleProjectSessions(
              sortSessions(project.sessions), isOpen, isShowAll, COLLAPSED_LIMIT, project.sessions.length
            );
            const canExpandMore = project.sessions.length > COLLAPSED_LIMIT;

            return (
              <div className="msx-proj" key={project.path}>
                <div
                  className={`msx-phead${isOpen ? ' open' : ''}`}
                  onClick={() => handleProjectTap(project)}
                  onTouchStart={() => startLongPress(project)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onContextMenu={(e) => { e.preventDefault(); onRequestRemoveProject(project); }}
                >
                  <div className="msx-folder"><FolderOutlined /></div>
                  <div className="msx-pbody">
                    <div className="msx-pname">{project.name}</div>
                    <div className="msx-pmeta">
                      {project.sessionTotal ?? project.sessions.length} 会话
                      {runCount > 0 && <> · <span className="run">{runCount} 运行中</span></>}
                    </div>
                  </div>
                  <div className="msx-avatars">
                    {(project.providers || []).map((p) => (
                      <span key={p} className={`av${runningProviders.has?.(p) ? ' spin' : ''}`}>
                        <ProviderIcon provider={p} size={19} />
                      </span>
                    ))}
                  </div>
                  <span className="msx-chev"><Chevron /></span>
                </div>

                <div className={`msx-drawer${isOpen ? ' open' : ''}`}>
                  <div>
                    <div className="msx-subs">
                      {visible.length === 0 && (
                        <div className="msx-empty-subs">暂无会话，点击右上角 + 新建</div>
                      )}
                      {isHydratingSessions && (
                        <div className="msx-empty-subs"><LoadingOutlined spin /> 加载完整会话列表</div>
                      )}
                      {visible.map((session: Session) => {
                        const running = isSessionRunning(session, runningSessionKeys);
                        const active = selectedSession?.id === session.id;
                        const meta = previews[session.id] || {};
                        const model = meta.model || session.model;
                        const preview = meta.preview || session.preview;
                        return (
                          <div
                            className={`msx-sub${active ? ' active' : ''}${running ? ' running' : ''}`}
                            key={session.id}
                            onClick={() => onSelectSession(session)}
                          >
                            <span className={`msx-avi${running ? ' spin' : ''}`}>
                              <ProviderIcon provider={session.provider} size={22} />
                            </span>
                            <div className="msx-sbody">
                              <div className="msx-titrow">
                                <span className={`msx-tit${preview ? '' : ' twoline'}`}>{session.title}</span>
                                <span className={`msx-time${running ? ' run' : ''}`}>
                                  {running ? '进行中' : dayjs(session.updatedAt).fromNow()}
                                </span>
                              </div>
                              <div className="msx-metarow">
                                <span className="msx-provtag">{model || getProviderLabel(session.provider)}</span>
                                <button
                                  className="msx-subact"
                                  title="归档"
                                  onClick={(e) => { e.stopPropagation(); onRequestArchiveSession(session); }}
                                >
                                  <InboxOutlined />
                                </button>
                              </div>
                              {preview ? <div className="msx-prev">{preview}</div> : null}
                            </div>
                          </div>
                        );
                      })}
                      {canExpandMore && (
                        <div className="msx-more" onClick={() => toggleShowAll(project.path)}>
                          {isShowAll ? '收起' : '展开更多'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default MobileSessions;
