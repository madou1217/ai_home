import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, Space, Spin, Tag, Typography, message } from 'antd';
import { DownloadOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { ClientTerminalItem } from '@/types';

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
  }
  return fallback;
}

export default function TerminalManagerPanel() {
  const [terminals, setTerminals] = useState<ClientTerminalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await toolkitAPI.listTerminals();
      if (!response.ok) throw new Error('终端接口未返回可用结果');
      setTerminals(response.terminals || []);
    } catch (error: unknown) {
      message.error(requestError(error, '读取终端清单失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runAction = async (terminal: ClientTerminalItem, action: 'install' | 'update' | 'uninstall') => {
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
        onOk: async () => {
          setWorkingId(`${terminal.id}:${action}`);
          try {
            const result = await toolkitAPI.executeTerminalAction(terminal.id, action);
            if (!result.ok) throw new Error(result.error || '终端操作失败');
            message.success(`${terminal.name}${action === 'install' ? '安装' : action === 'update' ? '更新' : '卸载'}完成`);
            await load();
          } catch (error: unknown) {
            message.error(requestError(error, '终端操作失败'));
          } finally {
            setWorkingId('');
          }
        }
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
          <p>CLI 入口统一使用这里探测到的终端。安装、更新和卸载只调用对应平台的官方包管理器。</p>
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
                  {terminal.canInstall && <Button size="small" type="primary" icon={<DownloadOutlined />} loading={workingId === `${terminal.id}:install`} onClick={() => void runAction(terminal, 'install')}>安装</Button>}
                  {terminal.canUpdate && <Button size="small" icon={<ReloadOutlined />} loading={workingId === `${terminal.id}:update`} onClick={() => void runAction(terminal, 'update')}>更新</Button>}
                  {terminal.canUninstall && <Button size="small" danger icon={<DeleteOutlined />} loading={workingId === `${terminal.id}:uninstall`} onClick={() => void runAction(terminal, 'uninstall')}>卸载</Button>}
                </Space>
              </div>
            </article>
          ))}
        </div>
      ) : <Empty description="当前平台没有可管理的终端" />}
    </section>
  );
}
