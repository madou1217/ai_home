import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { CodeOutlined, CopyOutlined, PlusOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons';
import { Button, Input, Select, message } from 'antd';
import HudStateView from '@/components/hud/HudStateView';
import Reveal from '@/components/ui/Reveal';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import { useWebTerminalManager } from '@/features/web-terminal/web-terminal-context';
import { useOpenProjectTerminal } from '@/features/web-terminal/use-open-project-terminal';
import './TerminalSessions.css';

function readHidden(serverId: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(`aih:terminal-overview:hidden:${serverId}`) || '[]'); return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : []; } catch { return []; }
}

export default function TerminalSessions() {
  const manager = useWebTerminalManager();
  useLayoutEffect(() => {
    manager.setOverviewVisible(true);
    return () => manager.setOverviewVisible(false);
  }, [manager.setOverviewVisible]);
  const directory = manager.directory;
  const openProjectTerminal = useOpenProjectTerminal();
  const [hiddenState, setHidden] = useState(() => ({ serverId: manager.serverId, keys: readHidden(manager.serverId) }));
  const hidden = useMemo(() => hiddenState.serverId === manager.serverId ? hiddenState.keys : readHidden(manager.serverId), [hiddenState, manager.serverId]);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  useEffect(() => {
    manager.adoptSessions(directory.sessions.filter((session) => session.status === 'running' && !hidden.includes(session.sessionKey)).map((session) => ({
      sessionKey: session.sessionKey, label: session.label, cwd: session.cwd,
      kind: session.source === 'native' ? 'account-cli' : 'shell', harness: session.provider, nativeSessionId: session.nativeSessionId,
    })));
  }, [directory.sessions, hidden, manager.adoptSessions]);
  const copyIdentity = async (label: string, key: string, nativeSessionId?: string) => {
    try {
      await navigator.clipboard.writeText([label, nativeSessionId, key].filter(Boolean).join('\n'));
      message.success('已复制原会话标识；不会自动重启任务');
    } catch { message.error('复制失败，请手动选择下方原会话标识'); }
  };
  const hide = useCallback((id: string) => {
    const tab = manager.tabs.find((item) => item.id === id);
    if (!tab) return;
    setHidden((current) => {
      const keys = [...new Set([...(current.serverId === manager.serverId ? current.keys : readHidden(manager.serverId)), tab.sessionKey])];
      try { localStorage.setItem(`aih:terminal-overview:hidden:${manager.serverId}`, JSON.stringify(keys)); } catch { /* session remains usable */ }
      return { serverId: manager.serverId, keys };
    });
    manager.closeTab(id);
  }, [hidden, manager]);
  const restoreHidden = () => {
    setHidden({ serverId: manager.serverId, keys: [] });
    try { localStorage.removeItem(`aih:terminal-overview:hidden:${manager.serverId}`); } catch { /* ignore */ }
  };
  const candidates = manager.tabs.filter((tab) => !hidden.includes(tab.sessionKey));
  const filtered = candidates.filter((tab) => (provider === 'all' || tab.harness === provider)
    && `${tab.label} ${tab.cwd} ${tab.harness || ''}`.toLowerCase().includes(query.toLowerCase()));
  const unavailable = manager.unavailableTabs.filter((tab) => !hidden.includes(tab.sessionKey)
    && (provider === 'all' || tab.harness === provider)
    && `${tab.label} ${tab.cwd} ${tab.nativeSessionId || ''} ${tab.sessionKey}`.toLowerCase().includes(query.toLowerCase()));
  const options = [...new Set([...candidates, ...manager.unavailableTabs].map((tab) => tab.harness).filter(Boolean))];
  const active = candidates.find((tab) => tab.id === manager.activeTabId) || candidates[0];
  const select = (id: string) => { manager.setActiveTab(id); setQuery(''); setProvider('all'); };
  return <main className="terminal-overview aih-panel-enter">
    <header className="terminal-overview-header">
      <div><span className="terminal-overview-eyebrow">SYS // LIVE SESSIONS</span><h1><CodeOutlined className="terminal-overview-title-icon" /> 会话总览 <span className="terminal-overview-count">{candidates.length}</span></h1></div>
      <div className="terminal-overview-actions">
        <Button icon={<ReloadOutlined />} loading={directory.loading} onClick={() => void directory.refresh()}>刷新会话</Button>
        {hidden.length ? <Button icon={<EyeOutlined />} onClick={restoreHidden}>显示已隐藏 ({hidden.length})</Button> : null}
        <Button type="primary" icon={<PlusOutlined />} onClick={() => void openProjectTerminal(active?.cwd)}>项目终端</Button>
      </div>
    </header>
    <div className="terminal-overview-toolbar hud-panel hud-panel--sm">
      <Input.Search aria-label="查找会话" placeholder="查找名称、项目路径" value={query} onChange={(event) => setQuery(event.target.value)} allowClear />
      <Select aria-label="筛选会话类型" value={provider} onChange={setProvider} options={[{ value: 'all', label: '全部类型' }, ...options.map((value) => ({ value, label: value }))]} />
      <span className="terminal-overview-help">点击预览切换，直接在主窗口输入 · 关闭原生会话视图会保留后台任务</span>
      {directory.error ? <span className="terminal-overview-error" role="status"><span className="hud-led hud-led--err" aria-hidden="true" />{directory.error}</span> : null}
    </div>
    <Reveal open={Boolean(query || provider !== 'all')}>
      <nav className="terminal-overview-results" aria-label="查找结果">
        {filtered.length ? filtered.map((tab) => <button key={tab.id} type="button" data-active={tab.id === active?.id ? 'true' : undefined} onClick={() => select(tab.id)} title={tab.cwd}>{tab.label}</button>) : <span className="terminal-overview-no-match">没有匹配的会话</span>}
      </nav>
    </Reveal>
    <Reveal open={unavailable.length > 0}>
      <section className="terminal-overview-unavailable hud-panel hud-panel--sm" aria-label="暂不可接入的原会话">
        <div className="terminal-overview-unavailable-heading">
          <span className="terminal-overview-unavailable-status" role="status"><span className="hud-led hud-led--warn" aria-hidden="true" />{unavailable.length} 个原会话暂未确认可接入，标识已保留</span>
          <span>刷新后会重新核对；不会替换为同名终端或自动续跑</span>
        </div>
        <ul>{unavailable.map((tab) => <li key={tab.id}>
          <div><strong>{tab.label}</strong><span>当前会话目录尚未确认可接入，不代表原会话已结束</span></div>
          <code title={tab.sessionKey}>{tab.nativeSessionId || tab.sessionKey}</code>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copyIdentity(tab.label, tab.sessionKey, tab.nativeSessionId)}>复制原标识</Button>
        </li>)}</ul>
      </section>
    </Reveal>
    <div className="terminal-overview-workspace">
      {candidates.length ? <ShellTerminalPanel key={manager.serverId} visible persistent compactChrome title="会话终端"
        sessionTabs={candidates.map((tab) => ({ ...tab, persistent: true }))} activeTabId={active?.id}
        onActiveTabChange={manager.setActiveTab} onTabClose={hide} layout="gallery" panelHeight={700}
        onClose={() => message.info('会话视图已关闭，后台任务继续运行')} allowNewTab={false} minimized={false} />
        : directory.loading ? <div className="terminal-overview-empty"><HudStateView variant="loading" code="SYS // DISCOVERING" title="正在发现运行中的会话" description="正在同步当前 Server 上的活跃终端与原生 CLI 会话" /></div>
          : <div className="terminal-overview-empty"><HudStateView code="NO_TERMINALS" title="当前服务器没有可显示的会话" description="打开项目终端，或在账号管理 / AI 会话页启动 CLI 后会自动汇聚在此" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => void openProjectTerminal()}>打开终端</Button>} /></div>}
    </div>
  </main>;
}
