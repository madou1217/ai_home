import { useCallback, useEffect, useMemo, useState } from 'react';
import { history } from '@umijs/max';
import { ArrowLeftOutlined, CodeOutlined, ExperimentOutlined, ReloadOutlined } from '@ant-design/icons';
import { getEnvironmentCategoryLabel } from '@/components/toolkit/environment-presentation';
import type { GuidedCommandTask } from '@/components/toolkit/guided-command';
import { toolkitRequestError } from '@/components/toolkit/request-error';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudChips,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow
} from '@/mobile/ui';
import { toolkitAPI } from '@/services/api';
import type { ClientPlatform, EnvironmentGuideResponse, EnvironmentGuideTool } from '@/types';
import type { MobilePageProps } from '../mobile-routes';
import GuidedCommand from './toolkit/GuidedCommand';
import { InlineError, StatusText } from './toolkit/toolkit-parts';
import styles from './MobileToolkit.module.css';

type RuntimeId = 'node' | 'python';

const RUNTIME_ITEMS = [
  { key: 'node', label: 'Node.js', icon: <CodeOutlined /> },
  { key: 'python', label: 'Python', icon: <ExperimentOutlined /> }
];

function guideTasks(tool: EnvironmentGuideTool): GuidedCommandTask[] {
  return tool.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    command: task.template,
    category: task.category,
    platform: task.method,
    parameters: task.parameters,
    danger: ['install', 'update', 'uninstall'].includes(task.category)
  }));
}

/**
 * 安装指南（/toolkit/install-guide）移动端：01 目标系统 → 02 工具链 → 工具列表，
 * 点按工具在底部抽屉里生成命令并复制；命令只生成和复制，不会自动执行。
 */
export default function MobileInstallGuide(_props: MobilePageProps) {
  const [data, setData] = useState<EnvironmentGuideResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [platform, setPlatform] = useState<ClientPlatform | ''>('');
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const [openToolId, setOpenToolId] = useState('');

  const load = useCallback(async (requestedPlatform?: ClientPlatform) => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getEnvironmentGuide(requestedPlatform);
      if (!response.ok) throw new Error('安装指南接口未返回可用结果');
      setData(response);
      setPlatform(response.platform);
    } catch (requestFailure: unknown) {
      setError(toolkitRequestError(requestFailure, '读取安装指南失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.runtime === runtime),
    [data, runtime]
  );
  const openTool = tools.find((tool) => tool.id === openToolId) || null;
  const tasks = useMemo(() => (openTool ? guideTasks(openTool) : []), [openTool]);

  return (
    <MobilePage
      toolbar={(
        <MobileToolbar
          start={<HudIconButton icon={<ArrowLeftOutlined />} label="返回开发工具" showLabel onClick={() => history.push('/toolkit')} />}
        >
          <HudIconButton icon={<ReloadOutlined />} label="重新读取" loading={loading} onClick={() => void load(platform || undefined)} />
        </MobileToolbar>
      )}
      lead="一次只查看一个系统；命令仅生成和复制，不会自动执行。"
    >
      {error ? <InlineError title="指南读取失败" detail={error} onRetry={() => void load(platform || undefined)} retrying={loading} /> : null}

      {loading && !data ? (
        <MobileBoot label="BUILDING PLAYBOOK" />
      ) : data ? (
        <>
          <div className={styles.step}>
            <span className={styles.stepLabel}><span className={styles.stepCode}>01</span>目标系统</span>
            <HudChips
              ariaLabel="目标系统"
              value={platform}
              onChange={(value) => void load(value as ClientPlatform)}
              items={data.platforms.map((item) => ({
                key: item.id,
                label: item.id === data.currentPlatform ? `${item.label} · 当前` : item.label,
                disabled: loading
              }))}
            />
          </div>
          <div className={styles.step}>
            <span className={styles.stepLabel}><span className={styles.stepCode}>02</span>工具链</span>
            <HudChips ariaLabel="工具链" value={runtime} onChange={(value) => setRuntime(value as RuntimeId)} items={RUNTIME_ITEMS} />
          </div>

          <HudSection title="运行环境工具" code={`${platform.toUpperCase()} / ${runtime.toUpperCase()}`} count={tools.length}>
            {tools.length ? (
              <MonoList ariaLabel="运行环境工具">
                {tools.map((tool) => (
                  <SwipeRow key={tool.id} onTap={() => setOpenToolId(tool.id)} ariaLabel={`${tool.name} 命令生成器`}>
                    <span className="mhud-row__icon">{runtime === 'node' ? <CodeOutlined /> : <ExperimentOutlined />}</span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{tool.name}</span>
                      <span className="mhud-row__meta">{tool.description}</span>
                    </span>
                    <span className="mhud-row__side">
                      <StatusText tone="info">{getEnvironmentCategoryLabel(tool.category)}</StatusText>
                    </span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="当前系统没有对应工具指南" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet
        open={Boolean(openTool)}
        onClose={() => setOpenToolId('')}
        code={`${platform.toUpperCase()} / ${runtime.toUpperCase()}`}
        title={openTool?.name || '命令生成器'}
      >
        {openTool ? (
          <div className={styles.sheetStack}>
            <p className={styles.prose}>{openTool.description}</p>
            <GuidedCommand key={`${platform}:${openTool.id}`} tasks={tasks} />
          </div>
        ) : null}
      </DetailSheet>
    </MobilePage>
  );
}
