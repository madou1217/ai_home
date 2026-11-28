import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, message, Tooltip } from 'antd';
import {
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  FolderOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import {
  globalSessionsAPI,
  type GlobalSessionPreviewEntry,
  type GlobalSessionRow,
} from '@/services/api';
import { writeClipboardText } from '@/utils/clipboard';
import './SessionOffice.css';

export interface SessionOfficeProps {
  defaultRoomKey?: string;
  defaultSessionKey?: string;
}

const POLL_MS = 4000;
const PREVIEW_LIMIT = 9;

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
  latestMessage: string;
  preview: GlobalSessionPreviewEntry[];
  previewSource: string;
}

function resolveState(row: GlobalSessionRow): { state: SessionState; label: string } {
  if (row.PaneDead) return { state: 'ended', label: '已结束' };
  const alive = row.Live || Boolean(String(row.Socket || '').trim()) || Number(row.PanePID || 0) > 0;
  if (!alive) return { state: 'ended', label: '已结束' };
  const turn = String(row.TurnState || '').toLowerCase();
  if (turn === 'working') return { state: 'working', label: '运行中' };
  if (turn === 'waiting') return { state: 'waiting', label: '等待输入' };
  if (turn === 'completed' || turn === 'idle') return { state: 'idle', label: '空闲' };
  if (row.Live) return { state: 'working', label: '运行中' };
  return { state: 'idle', label: '空闲' };
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
  const message = String(row.LastMessage || '').trim();
  const role = String(row.LastMessageRole || '').trim();
  const preview = Array.isArray(row.Preview) ? row.Preview.filter((entry) => String(entry?.Text || '').trim()) : [];
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
    lastActive: Number(row.LastMessageAtMS || row.LastActiveAtMS || row.LastActivityAtMS || row.CreatedAtMS || 0),
    latestMessage: message ? (role ? `${role} · ${message}` : message) : '',
    preview,
    previewSource: String(row.PreviewSource || (preview.length > 0 ? 'transcript' : '')),
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

function providerAccent(provider: string): string {
  switch (String(provider || '').toLowerCase()) {
    case 'claude':
      return '#d97757';
    case 'codex':
      return '#10a37f';
    case 'codebuddy':
    case 'codebuddycn':
      return '#4f7cff';
    case 'gemini':
    case 'agy':
      return '#4285f4';
    case 'grok':
      return '#8b5cf6';
    default:
      return 'var(--color-accent)';
  }
}

function entryRoleClass(entry: GlobalSessionPreviewEntry): string {
  const kind = String(entry.Kind || '').toLowerCase();
  if (kind === 'screen') return 'is-screen';
  if (kind === 'user') return 'is-user';
  if (kind === 'tool') return 'is-tool';
  return 'is-assistant';
}

export default function SessionOffice({ defaultSessionKey }: SessionOfficeProps) {
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
          item.latestMessage,
          item.preview.map((entry) => entry.Text).join(' '),
        ].join(' ').toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((left, right) => {
        const rank: Record<SessionState, number> = { working: 0, waiting: 1, idle: 2, ended: 3 };
        if (rank[left.state] !== rank[right.state]) return rank[left.state] - rank[right.state];
        return right.lastActive - left.lastActive;
      });
  }, [items, providerFilter, query]);

  const counts = useMemo(() => {
    const result = { working: 0, waiting: 0, idle: 0, ended: 0 };
    for (const item of items) result[item.state] += 1;
    return result;
  }, [items]);

  const focusSessionKey = String(defaultSessionKey || '').trim();

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
          <span className="session-list-eyebrow">AIH // LIVE SESSIONS</span>
          <h1>项目办公室</h1>
          <p>全部 `aih ss` 会话，按卡片实时展示运行状态与最新内容：原生会话为实时对话/工具流，tmux 会话为终端画面。</p>
        </div>

        <div className="session-list-metrics" aria-label="会话统计">
          <span className="session-list-metric"><i className="status-dot status-dot--working" />运行中 {counts.working}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--waiting" />等待输入 {counts.waiting}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--idle" />空闲 {counts.idle}</span>
          <span className="session-list-metric"><i className="status-dot status-dot--ended" />已结束 {counts.ended}</span>
        </div>

        <div className="session-list-controls">
          <Input.Search
            aria-label="搜索会话与实时内容"
            placeholder="搜索名称、Provider、项目、会话 ID、实时内容"
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

      <section className="session-card-grid" aria-label="会话卡片">
        {loading && items.length === 0 ? (
          <div className="session-list-empty">正在读取 aih ss 会话…</div>
        ) : filtered.length === 0 ? (
          <div className="session-list-empty">
            {focusSessionKey || query ? '没有匹配当前筛选的会话' : '当前没有 aih ss 会话'}
          </div>
        ) : (
          filtered.map((item) => {
            const isFocus = focusSessionKey
              && (item.NativeID === focusSessionKey || item.Name === focusSessionKey || item.key === focusSessionKey);
            const preview = item.preview.slice(-PREVIEW_LIMIT);
            const sourceLabel = item.previewSource === 'tmux' ? '终端画面' : item.previewSource === 'transcript' ? '实时对话' : '';
            return (
              <article
                key={item.key}
                className={`session-card${isFocus ? ' is-focus' : ''}`}
                data-state={item.state}
                style={{ ['--provider-accent' as string]: providerAccent(item.Provider) }}
              >
                <header className="session-card-head">
                  <span className="session-card-provider">
                    <ProviderIcon provider={item.Provider} size={18} />
                    <span>{item.Provider || 'unknown'}</span>
                  </span>
                  <span className={`session-card-status session-card-status--${item.state}`}>
                    <i className={`status-dot status-dot--${item.state}`} aria-hidden="true" />
                    {item.stateLabel}
                  </span>
                </header>

                <h2 className="session-card-title" title={item.title}>{item.title}</h2>

                <div className="session-card-meta">
                  <span className="session-card-project" title={item.projectPath || '未指定目录'}>
                    <FolderOutlined />
                    {item.projectName}
                  </span>
                  <span>{item.accountLabel}</span>
                  <span>{formatTime(item.lastActive)}</span>
                </div>

                <div className="session-card-screen" aria-label={sourceLabel || '实时内容'}>
                  <div className="session-card-screen-head">
                    <span className="session-card-screen-label">
                      {sourceLabel || '实时内容'}
                      {item.state === 'working' ? <i className="session-card-live" aria-label="正在输出" /> : null}
                    </span>
                    <span className="session-card-screen-time">{formatTime(item.lastActive)}</span>
                  </div>
                  <div className="session-card-screen-body">
                    {preview.length === 0 ? (
                      <span className="session-card-screen-empty">
                        {item.state === 'ended' ? '会话已结束，无更多内容' : '暂无实时内容'}
                      </span>
                    ) : (
                      preview.map((entry, index) => (
                        <div
                          key={`${item.key}-${index}-${entry.AtMS || 0}`}
                          className={`session-card-line ${entryRoleClass(entry)}`}
                        >
                          <span className="session-card-line-role">{entry.Role || '·'}</span>
                          <span className="session-card-line-text" title={entry.Text}>{entry.Text}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <footer className="session-card-foot">
                  <span className="session-card-id" title={item.NativeID || item.Name}>
                    {item.NativeID || item.Name || '-'}
                  </span>
                  <div className="session-card-actions">
                    <Tooltip title="复制会话 ID">
                      <Button
                        size="small"
                        type="text"
                        aria-label="复制会话 ID"
                        icon={copiedKey === `id:${item.key}` ? <CheckOutlined /> : <CopyOutlined />}
                        onClick={() => void handleCopy(`id:${item.key}`, item.NativeID || item.Name || item.key, '会话 ID 已复制')}
                      />
                    </Tooltip>
                    <Tooltip title={`复制进入命令：${entryCommand(item)}`}>
                      <Button
                        size="small"
                        type="text"
                        aria-label="复制进入命令"
                        icon={copiedKey === `cmd:${item.key}` ? <CheckOutlined /> : <CodeOutlined />}
                        onClick={() => void handleCopy(`cmd:${item.key}`, entryCommand(item), '进入命令已复制')}
                      />
                    </Tooltip>
                  </div>
                </footer>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}