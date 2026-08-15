import { Alert, Space } from 'antd';
import {
  CopyOutlined,
  CloudDownloadOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { ProxyCoreStatus } from '@/types';
import { copyText, coreStatusPresentation } from './proxy-pool-utils';

export type CoreAction = 'start' | 'stop' | 'reload';

interface ProxyCoreStatusRailProps {
  core: ProxyCoreStatus | null;
  pendingAction: CoreAction | null;
  onAction: (action: CoreAction) => void;
  onInstall: () => void;
  installPending: boolean;
}

export default function ProxyCoreStatusRail({
  core,
  pendingAction,
  onAction,
  onInstall,
  installPending
}: ProxyCoreStatusRailProps) {
  const presentation = coreStatusPresentation(core);

  return (
    <Alert
      className="toolkit-status-rail"
      type={presentation.type}
      showIcon
      icon={<SafetyCertificateOutlined />}
      message={presentation.title}
      description={presentation.description}
      action={(
        <Space wrap>
          {core && !core.installed && (
            <>
              <Button
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={installPending}
                onClick={onInstall}
              >
                自动安装 Mihomo
              </Button>
              <Button
                href="https://github.com/MetaCubeX/mihomo/releases"
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
    />
  );
}
