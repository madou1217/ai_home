import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftOutlined, CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import PageScaffold from '@/components/ui/PageScaffold';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import GuidedCommandPanel, {
  type GuidedCommandTask
} from '@/components/toolkit/GuidedCommandPanel';
import { getEnvironmentCategoryLabel } from '@/components/toolkit/environment-presentation';
import { resolveRuntimePlugins } from '@/components/toolkit/runtime-plugin-presentation';
import ToolkitGuideSteps from '@/features/toolkit/ToolkitGuideSteps';
import { buildAppHref } from '@/services/app-navigation';
import { toolkitAPI } from '@/services/api';
import type {
  ClientPlatform,
  EnvironmentGuideResponse,
  EnvironmentGuideTool
} from '@/types';
import './Toolkit.css';

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
  }
  return fallback;
}

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

export default function ToolkitInstallGuide() {
  const [data, setData] = useState<EnvironmentGuideResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [platform, setPlatform] = useState<ClientPlatform | ''>('');
  const [runtime, setRuntime] = useState('node');
  const [selectedToolId, setSelectedToolId] = useState('');
  const { surfaceRef: workbenchRef, switchSurface: switchWorkbench } = useSurfaceSwitch<HTMLDivElement>();
  const { surfaceRef: detailRef, switchSurface: switchDetail } = useSurfaceSwitch<HTMLDivElement>();

  const load = useCallback(async (requestedPlatform?: ClientPlatform) => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getEnvironmentGuide(requestedPlatform);
      if (!response.ok) throw new Error('安装指南接口未返回可用结果');
      setData(response);
      setPlatform(response.platform);
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取安装指南失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runtimePlugins = useMemo(() => resolveRuntimePlugins(undefined, data?.tools), [data]);
  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.runtime === runtime),
    [data, runtime]
  );
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) || tools[0] || null;

  useEffect(() => {
    setSelectedToolId((current) => (tools.some((tool) => tool.id === current) ? current : (tools[0]?.id || '')));
  }, [tools]);

  const handlePlatformChange = useCallback((nextPlatform: ClientPlatform) => {
    if (!data) return;
    const order = data.platforms.map((item) => item.id);
    switchWorkbench(() => {
      setPlatform(nextPlatform);
      void load(nextPlatform);
    }, {
      slot: 'platform',
      current: platform,
      next: nextPlatform,
      direction: platform ? resolveOrderedDirection(order, platform, nextPlatform) : 'neutral'
    });
  }, [data, load, platform, switchWorkbench]);

  const handleRuntimeChange = useCallback((nextRuntime: string) => {
    const order = runtimePlugins.map((plugin) => plugin.id);
    switchWorkbench(() => setRuntime(nextRuntime), {
      slot: 'runtime',
      current: runtime,
      next: nextRuntime,
      direction: resolveOrderedDirection(order, runtime, nextRuntime)
    });
  }, [runtime, runtimePlugins, switchWorkbench]);

  return (
    <PageScaffold
      title="安装指南"
      code="INSTALL_GUIDE"
      subTitle="按系统生成可复制的安装命令，不会自动执行。"
      className="toolkit-scaffold toolkit-guide-scaffold"
      ghost
      extra={(
        <div className="toolkit-guide-header-actions">
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load(platform || undefined)}
          >
            刷新
          </Button>
          <Button icon={<ArrowLeftOutlined />} href={buildAppHref('/toolkit')}>
            返回开发工具
          </Button>
        </div>
      )}
    >
      <div className="toolkit-guide-stack">
        {error ? (
          <InlineNote
            tone="error"
            action={(
              <Button size="small" onClick={() => void load(platform || undefined)}>
                重试
              </Button>
            )}
          >
            读取安装指南失败：{error}
          </InlineNote>
        ) : null}

        {loading && !data ? (
          <section className="toolkit-guide-page hud-panel">
            <div className="toolkit-loading">
              <HudStateView variant="loading" code="SYS // PLAYBOOK" title="正在加载安装指南…" />
            </div>
          </section>
        ) : data ? (
          <>
            <ToolkitGuideSteps
              platforms={data.platforms}
              currentPlatform={data.currentPlatform}
              selectedPlatform={platform}
              runtimeOptions={runtimePlugins}
              selectedRuntime={runtime}
              selectedToolName={selectedTool?.name}
              hasTool={Boolean(selectedTool)}
              onPlatformChange={handlePlatformChange}
              onRuntimeChange={handleRuntimeChange}
            />

            <section className="toolkit-guide-page hud-panel" aria-label="工具命令详情">
              <div ref={workbenchRef} className="toolkit-workbench toolkit-guide-workbench">
                <nav className="toolkit-tool-index" aria-label="运行环境工具">
                  {tools.map((tool) => {
                    const isActive = tool.id === selectedTool?.id;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className="toolkit-tool-option"
                        data-active={isActive || undefined}
                        aria-current={isActive ? 'true' : undefined}
                        onClick={() => {
                          const order = tools.map((entry) => entry.id);
                          switchDetail(() => setSelectedToolId(tool.id), {
                            current: selectedTool?.id,
                            next: tool.id,
                            direction: selectedTool ? resolveOrderedDirection(order, selectedTool.id, tool.id) : 'neutral'
                          });
                        }}
                      >
                        <span className="toolkit-tool-option-main">
                          <strong>{tool.name}</strong>
                          <small>{getEnvironmentCategoryLabel(tool.category)}</small>
                        </span>
                        {isActive ? (
                          <CheckOutlined className="toolkit-tool-option-check" aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </nav>
                <div ref={detailRef} className="toolkit-workbench-detail">
                  {selectedTool ? (
                    <>
                      <div className="toolkit-detail-heading">
                        <div>
                          <h3>{selectedTool.name}</h3>
                          <p className="toolkit-detail-summary">{selectedTool.description}</p>
                        </div>
                        <SettingStatusTag
                          compact
                          status="saved"
                          label={`${platform.toUpperCase()} · ${getEnvironmentCategoryLabel(selectedTool.category)}`}
                        />
                      </div>
                      <GuidedCommandPanel
                        key={`${platform}:${selectedTool.id}`}
                        title="命令生成"
                        tasks={guideTasks(selectedTool)}
                      />
                    </>
                  ) : (
                    <HudStateView compact code="NO_GUIDE" title="当前系统暂无可用工具指南" />
                  )}
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </PageScaffold>
  );
}
