import { Segmented, Space, Tooltip } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import {
  CopyOutlined,
  CloudDownloadOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { ProxyCoreInfo, ProxyCoreStatus } from '@/types';
import { copyText, coreDisplayName, coreStatusPresentation } from './proxy-pool-utils';

export type CoreAction = 'start' | 'stop' | 'reload';

interface ProxyCoreStatusRailProps {
  core: ProxyCoreStatus | null;
  pendingAction: CoreAction | null;
  onAction: (action: CoreAction) => void;
  onInstall: () => void;
  installPending: boolean;
  /** 当前平台可用的内核插件；只有一个时不显示选择器。 */
  cores?: ProxyCoreInfo[];
  corePending?: boolean;
  onSelectCore?: (coreId: string) => void;
}

export default function ProxyCoreStatusRail({
  core,
  pendingAction,
  onAction,
  onInstall,
  installPending,
  cores = [],
  corePending = false,
  onSelectCore
}: ProxyCoreStatusRailProps) {
  const presentation = coreStatusPresentation(core);
  const name = coreDisplayName(core);
  const switchLocked = Boolean(core?.running);

  return (
    <InlineNote
      className="toolkit-status-rail"
      tone={presentation.type}
      icon={<SafetyCertificateOutlined />}
      description={presentation.description}
      action={(
        <Space wrap>
          {cores.length > 1 && onSelectCore && (
            <Tooltip title={switchLocked ? '停止当前代理核心后才能切换' : '选择代理池使用的代理核心'}>
              <Segmented
                aria-label="代理核心"
                size="small"
                value={core?.engine}
                disabled={switchLocked || corePending}
                options={cores.map((item) => ({ label: item.name, value: item.id }))}
                onChange={(value) => onSelectCore(String(value))}
              />
            </Tooltip>
          )}
          {core && !core.installed && (
            <>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={installPending}
                onClick={onInstall}
              >
                自动安装 {name}
              </Button>
              <Button
                href={core.releaseUrl || 'https://github.com/MetaCubeX/mihomo/releases'}
                target="_blank"
                rel="noreferrer"
              >
                官方发布页
              </Button>
            </>
          )}
          {core?.installed && !core.running && (
            <Button
              type="primary"
              icon={<PoweroffOutlined />}
              loading={pendingAction === 'start'}
              onClick={() => onAction('start')}
            >
              启动核心
            </Button>
          )}
          {core?.running && (
            <>
              {core.mixedProxyUrl && (
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => void copyText(core.mixedProxyUrl || '', '当前 mixed 代理地址已复制')}
                >
                  {core.mixedProxyUrl}
                </Button>
              )}
              <Button
                icon={<ReloadOutlined />}
                loading={pendingAction === 'reload'}
                onClick={() => onAction('reload')}
              >
                校验并重载
              </Button>
              <Button
                danger
                icon={<PoweroffOutlined />}
                loading={pendingAction === 'stop'}
                onClick={() => onAction('stop')}
              >
                停止核心
              </Button>
            </>
          )}
        </Space>
      )}
    >
      {presentation.title}
    </InlineNote>
  );
}
