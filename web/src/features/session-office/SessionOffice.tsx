import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, message } from 'antd';
import {
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { globalSessionsAPI, type GlobalSessionRow } from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';
import './SessionOffice.css';

export interface SessionOfficeProps {
  defaultRoomKey?: string;
  defaultSessionKey?: string;
}

const POLL_MS = 15000;

type SessionState = 'working' | 'waiting' | 'idle' | 'ended';

interface SessionItem extends GlobalSessionRow {
  key: string;
  state: SessionState;
  stateLabel: string;
  title: string;
  accountLabel: string;
  projectPath: string;
  projectName: string;
  lastActive: number;
}

function resolveState(row: GlobalSessionRow): { state: SessionState; label: string } {
  if (row.PaneDead || (!row.Live && !row.NativeOnly)) return { state: 'ended', label: '已结束' };
  const turn = String(row.TurnState || '').toLowerCase();
  if (turn === 'working') return { state: 'working', label: '运行中' };
  if (turn === 'waiting') return { state: 'waiting', label: '等待输入' };
  if (row.Live) return { state: 'idle', label: '空闲' };
  return { state: 'ended', label: '已结束' };
}

function projectNameOf(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '未指定目录';
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function toItem(row: GlobalSessionRow): SessionItem {
  const state = resolveState(row);
  const nativeId = String(row.NativeID || '').trim();
  const sessionKey = String(row.Socket || '').trim() && String(row.Name || '').trim()
    ? `tmux:${row.Socket}:${row.Name}`
    : nativeId || `${row.Provider}:${row.Name}`;
  return {
    ...row,
    key: sessionKey,
    state: state.state,
    stateLabel: state.label,
    title: String(row.Label || row.Title || row.Name || row.Provider || '未命名会话').trim(),
    accountLabel: row.AccountID
      ? `#${row.AccountID}`
      : row.AccountRef
        ? `#${row.AccountRef.slice(-6)}`
        : '-',
    projectPath: String(row.Path || row.StartPath || '').trim(),
    projectName: projectNameOf(row.Path || row.StartPath || ''),
    lastActive: Number(row.LastActiveAtMS || row.LastActivityAtMS || row.CreatedAtMS || 0),
  };
}

function formatTime(ms: number): string {
  if (!ms) return '-';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function entryCommand(item: SessionItem): string {
  const id = String(item.NativeID || item.Name || '').trim();
  if (!id) return 'aih ss';
  return `aih ss ${id}`;
}

export default function SessionOffice({ defaultRoomKey, defaultSessionKey }: SessionOfficeProps) {
  const [rows, setRows] = useState<GlobalSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [copiedKey, setCopiedKey] = useState('');
  const mountedRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await globalSessionsAPI.list();
      if (!mountedRef.current) return;
      if (!result?.ok || !Array.isArray(result.sessions)) {
        setError('会话清单暂不可用');
        return;
      }
      setRows(result.sessions);
      setError('');
    } catch {
      if (mountedRef.current) setError('会话清单读取失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, [load]);

  const items = useMemo(() => rows.map(toItem), [rows]);

  const providerOptions = useMemo(() => {
    const values = new Set<string>();
    for (const item of items) {
      const provider = String(item.Provider || '').trim();
      if (provider) values.add(provider);
    }
    return [
      { value: 'all', label: '全部 Provider' },
      ...[...values].sort().map((value) => ({ value, label: value })),
    ];
  }, [items]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items
      .filter((item) => providerFilter === 'all' || item.Provider === providerFilter)
      .filter((item) => {
        if (!normalizedQuery) return true;
        const haystack = [
          item.title,
          item.Name,
          item.Label,
          item.NativeID,
          item.Provider,
          item.projectName,
          item.projectPath,
          item.AccountRef,
        ].join(' ').toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((left, right) => {
        const rank: Record<SessionState, number> = { working: 0, waiting: 1, idle: 2, ended: 3 };
        if (rank[left.state] !== rank[right.state]) return rank[left.state] - rank[right.state];
        return right.lastActive - left.lastActive;
      });
  }, [items, providerFilter, query]);

  const groups = useMemo(() => {
    const byProject = new Map<string, SessionItem[]>();
    for (const item of filtered) {
      const key = item.projectPath || '__no_cwd__';
      const bucket = byProject.get(key);
      if (bucket) bucket.push(item);
      else byProject.set(key, [item]);
    }
    return [...byProject.entries()]
      .map(([path, sessions]) => ({ path, sessions }))
      .sort((left, right) => {
        if (left.path === '__no_cwd__') return 1;
        if (right.path === '__no_cwd__') return -1;
        return left.path.localeCompare(right.path);
      });
  }, [filtered]);

  const counts = useMemo(() => {
    const result = { working: 0, waiting: 0, idle: 0, ended: 0 };
    for (const item of items) result[item.state] += 1;
    return result;
  }, [items]);

  const focusSessionKey = String(defaultSessionKey || '').trim();
  const focusRoom = String(defaultRoomKey || '').trim();

  const handleCopy = useCallback(async (key: string, value: string, label: string) => {
    try {
      await writeClipboardText(value);
      setCopiedKey(key);
      message.success(label);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedKey(''), 1600);
    } catch {
      message.error('复制失败');
    }
  }, []);

  return (
    <main className="session-list-page">
      <header className="session-list-head">
        <div className="session-list-title-block">
          <span className="session-list-eyebrow">AIH // SESSIONS</span>
          <h1>项目办公室</h1>
          <p>来自 `aih ss` 的活跃与历史会话，不再渲染 3D 办公室。</p>
        </div>

        <div className="session-list-metrics" aria-label="会话统计">
          <span className="session-list-metric"><i className="status-dot status-dot--working" />运行中 {counts.working}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--waiting" />等待输入 {counts.waiting}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--idle" />空闲 {counts.idle}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--ended" />已结束 {counts.ended}</span>
        </div>

        <div className="session-list-controls">
          <Input.Search
            aria-label="搜索会话"
            placeholder="搜索名称、Provider、项目、会话 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            allowClear
          />
          <Select
            aria-label="筛选 Provider"
            value={providerFilter}
            onChange={setProviderFilter}
            options={providerOptions}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); void load(); }}>
            刷新
          </Button>
        </div>
      </header>

      {error ? <div className="session-list-inline-error">{error}</div> : null}

      <section className="session-list-body" aria-label="会话列表">
        {loading && items.length === 0 ? (
          <div className="session-list-empty">正在读取 aih ss 会话…</div>
        ) : groups.length === 0 ? (
          <div className="session-list-empty">
            {focusSessionKey || focusRoom ? '没有匹配当前筛选的会话' : '当前没有 aih ss 会话'}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.path} className="session-list-group" aria-label={group.path}>
              <header className="session-list-group-head">
                <div className="session-list-group-title">
                  <CodeOutlined />
                  <strong>{projectNameOf(group.path)}</strong>
                  <span title={group.path}>{group.path === '__no_cwd__' ? '未指定目录' : group.path}</span>
                </div>
                <span className="session-list-group-count">{group.sessions.length}</span>
              </header>

              <div className="session-list-rows" role="list">
                {group.sessions.map((item) => {
                  const isFocus = focusSessionKey && (item.NativeID === focusSessionKey || item.Name === focusSessionKey || item.key === focusSessionKey);
                  return (
                    <article
                      key={item.key}
                      role="listitem"
                      className={`session-list-row${isFocus ? ' is-focus' : ''}`}
                      data-state={item.state}
                    >
                      <span className={`status-dot status-dot--${item.state}`} aria-hidden="true" />
                      <div className="session-list-primary">
                        <div className="session-list-row-title">
                          <strong title={item.title}>{item.title}</strong>
                          <span className={`session-state-tag session-state-tag--${item.state}`}>{item.stateLabel}</span>
                        </div>
                        <div className="session-list-row-meta">
                          <span>{item.Provider || 'unknown'}</span>
                          <span>{item.accountLabel}</span>
                          <span className="session-list-native-id" title={item.NativeID || item.Name}>
                            {item.NativeID || item.Name || '-'}
                          </span>
                          <span>{formatTime(item.lastActive)}</span>
                        </div>
                      </div>
                      <div className="session-list-row-actions">
                        <Button
                          size="small"
                          icon={copiedKey === `id:${item.key}` ? <CheckOutlined /> : <CopyOutlined />}
                          onClick={() => void handleCopy(`id:${item.key}`, item.NativeID || item.Name || item.key, '会话 ID 已复制')}
                        >
                          复制 ID
                        </Button>
                        <Button
                          size="small"
                          icon={copiedKey === `cmd:${item.key}` ? <CheckOutlined /> : <CodeOutlined />}
                          onClick={() => void handleCopy(`cmd:${item.key}`, entryCommand(item), '进入命令已复制')}
                        >
                          复制进入命令
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </section>
    </main>
  );
}