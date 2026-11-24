import React from 'react';
import { Button, Tooltip, message } from 'antd';
import { DesktopOutlined, DownloadOutlined } from '@ant-design/icons';
import { toolkitAPI, waitForAppInstallJob } from '@/services/api';

interface ProviderDesktopSetupProps {
  /** 规范 Provider ID（应用清单里的 key）。 */
  provider: string;
  /** 应用清单里的展示名（例如 Antigravity）。 */
  label: string;
  /** 宿主机是否已安装该桌面客户端。 */
  installed: boolean;
  /** 安装结束后刷新 app-entries，入口状态随之切换。 */
  onRefresh: () => Promise<void> | void;
}

/**
 * Provider 级桌面端入口：没有任何账号时也能安装/打开官方客户端。
 *
 * 所有状态都来自 Toolkit 应用清单（appEntries / appCapabilities），这里不判断
 * 厂商：新增一个声明了桌面客户端的 Provider，自动获得同一套安装/打开动作。
 * 无桌面系统（serverRuntime）由调用方隐藏，不在组件里猜运行环境。
 */
export function ProviderDesktopSetup({ provider, label, installed, onRefresh }: ProviderDesktopSetupProps) {
  const [busy, setBusy] = React.useState<'install' | 'open' | ''>('');
  const appId = `${provider}-desktop`;

  const install = async () => {
    setBusy('install');
    try {
      const started = await toolkitAPI.executeAppAction(appId, 'install', 'desktop');
      if (!started.ok || !started.job) throw new Error(started.error || '安装任务未创建');
      const completed = await waitForAppInstallJob(started.job.id);
      if (completed.status !== 'succeeded') throw new Error(completed.error || '安装失败');
      message.success(`${label} 已安装`);
      await onRefresh();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '安装失败');
    } finally {
      setBusy('');
    }
  };

  const open = async () => {
    setBusy('open');
    try {
      await toolkitAPI.openManagedDesktopApp(appId);
      message.success(`已打开 ${label}`);
      await onRefresh();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '打开失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="accounts-provider-client-bar">
      <span className="accounts-provider-client-name">
        <DesktopOutlined /> {label} 桌面端
      </span>
      <span className="accounts-provider-client-state">{installed ? '已安装' : '未安装'}</span>
      <Tooltip title={installed ? `打开 ${label}` : `安装官方 ${label} 客户端`}>
        {installed ? (
          <Button size="small" type="primary" loading={busy === 'open'} onClick={() => void open()}>
            打开
          </Button>
        ) : (
          <Button size="small" icon={<DownloadOutlined />} loading={busy === 'install'} onClick={() => void install()}>
            安装
          </Button>
        )}
      </Tooltip>
    </div>
  );
}

export default ProviderDesktopSetup;
