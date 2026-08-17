import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { ClientPlatform, ClientTerminalItem } from '@/types';
import InstallLifecycleAction, { type InstallLifecycleActionName as TerminalAction } from './InstallLifecycleAction';

const PLATFORM_LABELS: Record<ClientPlatform, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
};

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
  }
  return fallback;
}

export default function TerminalManagerPanel() {
  const [terminals, setTerminals] = useState<ClientTerminalItem[]>([]);
  const [platform, setPlatform] = useState<ClientPlatform | ''>('');
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');
  const [openingId, setOpeningId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await toolkitAPI.listTerminals();
      if (!response.ok) throw new Error('终端接口未返回可用结果');
      setPlatform(response.platform || '');
      setTerminals((response.terminals || []).filter((terminal) => terminal.platform === response.platform));
    } catch (error: unknown) {
      message.error(requestError(error, '读取终端清单失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  const openTerminal = async (terminal: ClientTerminalItem) => {
    setOpeningId(terminal.id);
    try {
      const result = await toolkitAPI.openTerminal(terminal.id);
      if (!result.ok) throw new Error(result.error || '终端唤起失败');
      message.success(`${terminal.name} 已唤起`);
    } catch (error: unknown) {
      message.error(requestError(error, `${terminal.name} 唤起失败`));
    } finally {
      setOpeningId('');
    }
  };

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<{ source?: string }>).detail;
      if (task?.source === 'terminal') void load();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [load]);

  const submitTerminalAction = async (terminal: ClientTerminalItem, action: TerminalAction) => {
    setWorkingId(`${terminal.id}:${action}`);
    try {
      const result = await toolkitAPI.executeTerminalAction(terminal.id, action);
      if (!result.ok) throw new Error(result.error || '终端操作失败');
      message.info(`${terminal.name}${action === 'install' ? '安装' : action === 'update' ? '更新' : '卸载'}任务已提交，进度显示在右下角任务队列。`);
    } catch (error: unknown) {
      message.error(requestError(error, '终端操作失败'));
    } finally {
      setWorkingId('');
    }
  };

  const runAction = async (terminal: ClientTerminalItem, action: TerminalAction) => {
    try {
      const plan = await toolkitAPI.planTerminalAction(terminal.id, action);
      if (!plan.ok) throw new Error(plan.error || '无法生成终端操作计划');
      Modal.confirm({
        title: `${action === 'install' ? '安装' : action === 'update' ? '更新' : '卸载'} ${terminal.name}`,
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text>{plan.label || '将执行官方包管理器命令'}</Typography.Text>
            <Typography.Text code copyable>{plan.command}</Typography.Text>
          </Space>
        ),
        okText: '确认执行',
        cancelText: '取消',
        // 立即关闭确认层；命令已在服务端异步排队，进度只由全局任务队列呈现。
        onOk: () => { void submitTerminalAction(terminal, action); }
      });
    } catch (error: unknown) {
      message.error(requestError(error, '生成终端操作计划失败'));
    }
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-terminals-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">TERMINAL RUNTIME</div>
          <h2 id="toolkit-terminals-title">终端管理</h2>
          <p>仅显示当前平台（{platform ? PLATFORM_LABELS[platform] || platform : '当前主机'}）支持的终端；WebUI 可直接唤起已安装终端。安装、更新和卸载只调用对应平台的官方包管理器。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
      </header>
      {loading && !terminals.length ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测终端" /></div>
      ) : terminals.length ? (
        <div className="toolkit-grid">
          {terminals.map((terminal) => (
            <article key={terminal.id} className={`toolkit-app-card ${terminal.installed ? 'installed' : 'uninstalled'}`}>
              <div>
                <div className="toolkit-card-header">
                  <div className="toolkit-card-title-group">
                    <div className="toolkit-terminal-glyph" aria-hidden="true">⌘</div>
                    <div>
                      <h3 className="toolkit-card-title">{terminal.name}</h3>
                      <Space size={4} wrap>
                        <Tag color={terminal.default ? 'blue' : 'default'}>{terminal.default ? '系统默认' : '可选终端'}</Tag>
                        <Tag color={terminal.installed ? 'success' : 'default'}>{terminal.installed ? '已安装' : '未安装'}</Tag>
                      </Space>
                    </div>
                  </div>
                </div>
                <p className="toolkit-card-body toolkit-terminal-description">{terminal.description}</p>
                <dl className="toolkit-card-body">
                  <div className="toolkit-detail-row">
                    <dt className="toolkit-detail-label">程序路径</dt>
                    <dd className="toolkit-detail-value">
                      <Typography.Text ellipsis={{ tooltip: terminal.executablePath || '由系统默认终端解析' }}>
                        {terminal.executablePath || '由系统默认终端解析'}
                      </Typography.Text>
                    </dd>
                  </div>
                  {terminal.sourceUrl ? (
                    <div className="toolkit-detail-row">
                      <dt className="toolkit-detail-label">官方文档</dt>
                      <dd className="toolkit-detail-value">
                        <a href={terminal.sourceUrl} target="_blank" rel="noreferrer">安装说明</a>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              <div className="toolkit-card-actions">
                <Space size={6} wrap>
                  {terminal.canLaunch && (terminal.installed || terminal.default) && (
                    <Button
                      size="small"
                      icon={<ExportOutlined />}
                      loading={openingId === terminal.id}
                      onClick={() => void openTerminal(terminal)}
                    >
                      唤起终端
                    </Button>
                  )}
                  {terminal.canInstall && <InstallLifecycleAction action="install" size="small" loading={workingId === `${terminal.id}:install`} onClick={() => void runAction(terminal, 'install')} />}
                  {terminal.canUpdate && <InstallLifecycleAction action="update" size="small" loading={workingId === `${terminal.id}:update`} onClick={() => void runAction(terminal, 'update')} />}
                  {terminal.canUninstall && <InstallLifecycleAction action="uninstall" size="small" loading={workingId === `${terminal.id}:uninstall`} onClick={() => void runAction(terminal, 'uninstall')} />}
                </Space>
              </div>
            </article>
          ))}
        </div>
      ) : <Empty description="当前平台没有可管理的终端" />}
    </section>
  );
}
