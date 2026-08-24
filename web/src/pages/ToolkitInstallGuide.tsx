import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Segmented, Spin, Tag } from 'antd';
import { ArrowLeftOutlined, CodeOutlined, ExperimentOutlined, ReloadOutlined } from '@ant-design/icons';
import PageScaffold from '@/components/ui/PageScaffold';
import Button from '@/components/ui/AppButton';
import GuidedCommandPanel, {
  type GuidedCommandTask
} from '@/components/toolkit/GuidedCommandPanel';
import { getEnvironmentCategoryLabel } from '@/components/toolkit/environment-presentation';
import { buildAppHref } from '@/services/app-navigation';
import { toolkitAPI } from '@/services/api';
import type {
  ClientPlatform,
  EnvironmentGuideResponse,
  EnvironmentGuideTool
} from '@/types';
import './Toolkit.css';

type RuntimeId = 'node' | 'python';

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
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const [selectedToolId, setSelectedToolId] = useState('');

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

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.runtime === runtime),
    [data, runtime]
  );
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) || tools[0] || null;

  useEffect(() => {
    setSelectedToolId((current) => tools.some((tool) => tool.id === current) ? current : (tools[0]?.id || ''));
  }, [tools]);

  return (
    <PageScaffold
      title="安装指南与命令"
      subTitle="一次只查看一个系统；命令仅生成和复制，不会自动执行。"
      className="toolkit-scaffold toolkit-guide-scaffold"
      ghost
      headerContent={(
        <Button icon={<ArrowLeftOutlined />} href={buildAppHref('/toolkit')}>返回开发工具</Button>
      )}
    >
      <section className="toolkit-guide-page" aria-labelledby="toolkit-guide-title">
        <header className="toolkit-panel-header">
          <div>
            <div className="toolkit-panel-kicker">PLATFORM PLAYBOOK</div>
            <h2 id="toolkit-guide-title">运行环境安装指南</h2>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(platform || undefined)}>重新读取</Button>
        </header>

        {error ? (
          <div className="toolkit-inline-error" role="alert">
            <strong>指南读取失败</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading && !data ? (
          <div className="toolkit-loading"><Spin size="large" tip="正在生成当前系统指南" /></div>
        ) : data ? (
          <>
            <div className="toolkit-guide-controls">
              <div>
                <span className="toolkit-control-label">目标系统</span>
                <Segmented
                  aria-label="目标系统"
                  value={platform}
                  options={data.platforms.map((item) => ({
                    label: item.id === data.currentPlatform ? `${item.label} · 当前` : item.label,
                    value: item.id
                  }))}
                  onChange={(value) => void load(value as ClientPlatform)}
                />
              </div>
              <div>
                <span className="toolkit-control-label">工具链</span>
                <Segmented
                  aria-label="工具链"
                  value={runtime}
                  options={[
                    { label: 'Node.js', value: 'node', icon: <CodeOutlined /> },
                    { label: 'Python', value: 'python', icon: <ExperimentOutlined /> }
                  ]}
                  onChange={(value) => setRuntime(value as RuntimeId)}
                />
              </div>
            </div>

            <div className="toolkit-workbench toolkit-guide-workbench">
              <nav className="toolkit-tool-index" aria-label="运行环境工具">
                {tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    className="toolkit-tool-option"
                    data-active={tool.id === selectedTool?.id || undefined}
                    onClick={() => setSelectedToolId(tool.id)}
                  >
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                    </span>
                    <Tag>{getEnvironmentCategoryLabel(tool.category)}</Tag>
                  </button>
                ))}
              </nav>
              <div className="toolkit-workbench-detail">
                {selectedTool ? (
                  <>
                    <div className="toolkit-detail-heading">
                      <div>
                        <span>{platform.toUpperCase()} / {runtime.toUpperCase()}</span>
                        <h3>{selectedTool.name}</h3>
                      </div>
                      <Tag>{selectedTool.description}</Tag>
                    </div>
                    <GuidedCommandPanel
                      key={`${platform}:${selectedTool.id}`}
                      title="命令生成器"
                      tasks={guideTasks(selectedTool)}
                    />
                  </>
                ) : <Empty description="当前系统没有对应工具指南" />}
              </div>
            </div>
          </>
        ) : null}
      </section>
    </PageScaffold>
  );
}
