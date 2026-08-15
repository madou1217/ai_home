import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Collapse,
  Empty,
  Segmented,
  Spin,
  Tag
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  EnvironmentCheatsheetCommand,
  EnvironmentInfo,
  EnvironmentToolCheatsheet,
  EnvironmentsResponse
} from '@/types';
import GuidedCommandPanel, {
  type GuidedCommandParameter,
  type GuidedCommandTask
} from './GuidedCommandPanel';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import EnvironmentActionPanel from './EnvironmentActionPanel';

type RuntimeId = 'node' | 'python';
type ToolGroupId = 'version-managers' | 'package-managers' | 'virtual-environments';

interface EnvironmentToolEntry {
  tool: EnvironmentToolCheatsheet;
  group: ToolGroupId;
  groupLabel: string;
  detected: boolean;
  status: string;
}

const PARAMETER_LABELS: Record<string, Omit<GuidedCommandParameter, 'key'>> = {
  version: { label: '版本号', placeholder: '例如 22 或 3.12.7' },
  package: { label: '包名', placeholder: '例如 typescript' },
  environment: { label: '环境名称', placeholder: '例如 analytics' },
  environmentPath: { label: '环境目录', placeholder: '例如 .venv' },
  script: { label: '脚本路径', placeholder: '例如 scripts/check.py' }
};

function uniqueParameters(keys: string[]) {
  return Array.from(new Set(keys)).map((key) => ({ key, ...PARAMETER_LABELS[key] }));
}

function parameterizeCommand(toolId: string, command: string) {
  let template = command;
  const parameterKeys: string[] = [];
  const replace = (pattern: RegExp, replacement: string, key: string) => {
    if (!pattern.test(template)) return;
    template = template.replace(pattern, replacement);
    parameterKeys.push(key);
  };

  replace(/<package>/gi, '{{package}}', 'package');
  replace(/<script>/gi, '{{script}}', 'script');

  if (toolId === 'nvm' || toolId === 'fnm') {
    replace(/\b(?:22|20)(?:\.\d+){0,2}\b/g, '{{version}}', 'version');
  } else if (toolId === 'volta') {
    replace(/@(22|10)(?:\.\d+){0,2}\b/g, '@{{version}}', 'version');
  } else if (toolId === 'pyenv') {
    replace(/\b3\.(?:12\.7|11\.0)\b/g, '{{version}}', 'version');
  } else if (toolId === 'conda') {
    replace(/\bmyenv\b/g, '{{environment}}', 'environment');
    replace(/python=3\.11\b/g, 'python={{version}}', 'version');
  } else if (toolId === 'venv') {
    replace(/\.venv/g, '{{environmentPath}}', 'environmentPath');
  } else if (toolId === 'uv') {
    replace(/\.venv/g, '{{environmentPath}}', 'environmentPath');
    replace(/script\.py/g, '{{script}}', 'script');
  } else if (toolId === 'poetry') {
    replace(/main\.py/g, '{{script}}', 'script');
  } else if (toolId === 'bun') {
    replace(/index\.ts/g, '{{script}}', 'script');
  }

  return { template, parameters: uniqueParameters(parameterKeys) };
}

function classifyCommand(command: EnvironmentCheatsheetCommand) {
  const text = `${command.desc || command.label || ''} ${command.cmd}`;
  if (/卸载|删除|remove|uninstall|rm\s+-rf/i.test(text)) return 'uninstall' as const;
  if (/查看|列出|状态|list|versions|--version|-v\b/i.test(text)) return 'inspect' as const;
  if (/安装|install|curl\s|brew\s|winget\s|powershell/i.test(text)) return 'install' as const;
  if (/设置|固定|创建|config|alias|default|local|pin|init/i.test(text)) return 'configure' as const;
  return 'use' as const;
}

function splitInstallGuide(tool: EnvironmentToolCheatsheet) {
  const guide = String(tool.installGuide || '').trim();
  if (!guide) return [];

  const commands: Array<{ platform: string; command: string }> = [];
  const labelledPlatforms = guide.match(/^macOS:\s*(.*?)\s+\|\s+Linux:\s*(.*)$/i);
  if (labelledPlatforms) {
    commands.push({ platform: 'macOS', command: labelledPlatforms[1] });
    commands.push({ platform: 'Linux', command: labelledPlatforms[2] });
    return commands;
  }

  const windowsSuffix = guide.match(/^(.*?)\s*\(Windows:\s*(.*?)\)$/i);
  if (windowsSuffix) {
    commands.push({ platform: 'macOS / Linux', command: windowsSuffix[1].trim() });
    commands.push({ platform: 'Windows', command: windowsSuffix[2].trim() });
    return commands;
  }

  const homebrewCommand = guide.match(/Homebrew:\s*(.+)$/i);
  if (homebrewCommand) {
    commands.push({ platform: 'macOS', command: homebrewCommand[1].trim() });
    return commands;
  }

  if (/^(?:curl|brew|winget|powershell|iwr)\b/i.test(guide)) {
    commands.push({ platform: tool.platforms?.join(' / ') || '参考平台', command: guide });
  }
  return commands;
}

function buildTasks(tool: EnvironmentToolCheatsheet) {
  const tasks: GuidedCommandTask[] = [];
  const append = (
    commands: EnvironmentCheatsheetCommand[] | undefined,
    source: string,
    forcedCategory?: GuidedCommandTask['category']
  ) => {
    (commands || []).forEach((command, index) => {
      const category = forcedCategory || classifyCommand(command);
      const generated = parameterizeCommand(tool.id, command.cmd);
      tasks.push({
        id: `${tool.id}-${source}-${index}`,
        label: command.desc || command.label || command.method || `${tool.name} 命令`,
        command: generated.template,
        parameters: generated.parameters,
        category,
        platform: command.platform || command.method,
        danger: category === 'install' || category === 'uninstall',
        description: category === 'install' || category === 'uninstall'
          ? '该命令会改变本机工具链或已安装内容。'
          : undefined
      });
    });
  };

  append(tool.commands, 'command');
  append(tool.installCommands, 'install', 'install');
  append(tool.uninstallCommands, 'uninstall', 'uninstall');
  append(tool.commonCommands, 'common');

  if (tool.statusCmd) {
    tasks.unshift({
      id: `${tool.id}-status`,
      label: `检查 ${tool.name} 版本`,
      command: tool.statusCmd,
      category: 'inspect',
      description: '读取当前 AIH 所在 Shell 可见的工具版本。'
    });
  }

  if (!tool.installCommands?.length) {
    splitInstallGuide(tool).forEach((item, index) => {
      tasks.unshift({
        id: `${tool.id}-guide-install-${index}`,
        label: `安装 ${tool.name}`,
        command: item.command,
        category: 'install',
        platform: item.platform,
        danger: true,
        description: '安装指令来自服务端提供的工具指南，请确认来源与平台后再执行。'
      });
    });
  }

  return tasks;
}

function detectedStatus(runtime: RuntimeId, info: EnvironmentInfo, tool: EnvironmentToolCheatsheet) {
  const manager = info.versionManagers?.find((item) => item.name.toLowerCase() === tool.id.toLowerCase());
  if (manager) {
    return {
      detected: true,
      status: manager.version || (manager.versions?.length ? `${manager.versions.length} 个版本/环境` : '已检测')
    };
  }

  if (runtime === 'node' && ['pnpm', 'yarn', 'bun'].includes(tool.id)) {
    const version = info.packageManagers?.[tool.id as keyof NonNullable<EnvironmentInfo['packageManagers']>];
    return { detected: Boolean(version), status: version || '未检测到' };
  }

  if (runtime === 'python' && (tool.id === 'uv' || tool.id === 'poetry')) {
    const version = info.tools?.[tool.id as keyof NonNullable<EnvironmentInfo['tools']>];
    return { detected: Boolean(version), status: version || '未检测到' };
  }

  if (runtime === 'python' && tool.id === 'venv') {
    return {
      detected: Boolean(info.currentVersion),
      status: info.currentVersion ? '随当前 Python 可用' : '仅提供指南'
    };
  }

  return { detected: false, status: '仅提供指南' };
}

function environmentEntries(runtime: RuntimeId, info: EnvironmentInfo): EnvironmentToolEntry[] {
  const groups: Array<{
    id: ToolGroupId;
    label: string;
    tools: EnvironmentToolCheatsheet[] | undefined;
  }> = runtime === 'node'
    ? [
      { id: 'version-managers', label: '版本管理器', tools: info.cheatsheet?.versionManagers },
      { id: 'package-managers', label: '包管理器', tools: info.cheatsheet?.packageManagers }
    ]
    : [
      { id: 'version-managers', label: '版本管理器', tools: info.cheatsheet?.versionManagers },
      { id: 'virtual-environments', label: '虚拟环境与依赖', tools: info.cheatsheet?.virtualEnvironments }
    ];

  return groups.flatMap((group) => (group.tools || []).map((tool) => ({
    tool,
    group: group.id,
    groupLabel: group.label,
    ...detectedStatus(runtime, info, tool)
  })));
}

const FAQ_ITEMS = {
  node: [
    {
      key: 'node-manager-choice',
      label: 'NVM、FNM、Volta 应该选哪一个？',
      children: '已有团队约定时跟随项目；需要跨平台与更快启动可考虑 FNM；需要按项目固定 Node 与 npm 版本可考虑 Volta。不要在同一 Shell 初始化多个版本管理器。'
    },
    {
      key: 'node-detected-vs-installed',
      label: '为什么显示“仅提供指南”？',
      children: '实测轨道只反映 AIH 服务进程当前可见的 PATH 与用户目录。指南可用不代表工具已经安装，也不代表你的交互式 Shell 已完成初始化。'
    },
    {
      key: 'node-command-safety',
      label: '哪些操作可以在页面中执行？',
      children: 'NVM/FNM 的安装、卸载、默认版本以及后端白名单内的操作，可以先生成结构化计划，再显式确认执行。curl、brew 等安装管理器本身的脚本仍只提供复制，不会自动运行。'
    }
  ],
  python: [
    {
      key: 'python-env-choice',
      label: 'venv、uv、Conda、Poetry 如何选择？',
      children: '标准 Python 项目优先 venv；追求依赖安装速度可用 uv；科学计算与非 Python 依赖可用 Conda；需要项目依赖声明和发布流程可用 Poetry。'
    },
    {
      key: 'python-global-local',
      label: 'pyenv 与虚拟环境是什么关系？',
      children: 'pyenv 负责选择 Python 解释器版本，venv/uv/Conda/Poetry 负责项目依赖隔离。通常先选解释器，再为项目创建独立环境。'
    },
    {
      key: 'python-command-safety',
      label: '为什么复制按钮有时不可用？',
      children: '命令包含版本、包名或环境名称时必须先填写参数，避免把示例占位符直接粘贴到终端。'
    }
  ]
};

export default function EnvironmentPanel() {
  const [data, setData] = useState<EnvironmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const [selectedToolId, setSelectedToolId] = useState('');

  const fetchEnvironment = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getEnvironments();
      if (!response.ok) throw new Error('环境接口未返回可用结果');
      setData(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : '读取运行环境失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEnvironment();
  }, [fetchEnvironment]);

  const info = data?.environments[runtime];
  const entries = useMemo(
    () => info ? environmentEntries(runtime, info) : [],
    [info, runtime]
  );

  useEffect(() => {
    setSelectedToolId((current) => entries.some((entry) => entry.tool.id === current)
      ? current
      : (entries[0]?.tool.id || ''));
  }, [entries]);

  const selectedEntry = entries.find((entry) => entry.tool.id === selectedToolId) || entries[0];
  const selectedTasks = useMemo(
    () => selectedEntry ? buildTasks(selectedEntry.tool) : [],
    [selectedEntry]
  );
  const detectedCount = entries.filter((entry) => entry.detected).length;

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-environment-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">RUNTIME CONTROL</div>
          <h2 id="toolkit-environment-title">运行环境</h2>
          <p>先读取当前进程能看到的工具链，再按任务生成可检查、可复制的命令。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchEnvironment}>重新实测</Button>
      </header>

      {error && <Alert type="error" showIcon message="运行环境读取失败" description={error} />}
      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取 Node 与 Python 环境" /></div>
      ) : info ? (
        <>
          <ToolkitStatusTrack
            ariaLabel={`${runtime === 'node' ? 'Node.js' : 'Python'} 状态轨道`}
            items={[
              {
                label: '实测',
                value: info.currentVersion || '未检测到运行时',
                detail: `${info.activePath || '当前服务进程 PATH 中没有可执行文件'} · ${info.scope || 'scope 未标注'}`,
                tone: info.currentVersion ? 'success' : 'warning'
              },
              {
                label: '配置',
                value: `${detectedCount} / ${entries.length} 个工具可见`,
                detail: `${info.source || 'command-probe'} · ${info.probeStatus || '状态未标注'}`,
                tone: detectedCount ? 'info' : 'neutral'
              },
              {
                label: '指南',
                value: `${entries.length} 个工具任务库`,
                detail: '白名单操作可审阅后执行；脚本类指南只复制',
                tone: 'neutral'
              }
            ]}
          />

          <div className="toolkit-runtime-switch">
            <Segmented
              value={runtime}
              onChange={(value) => setRuntime(value as RuntimeId)}
              options={[
                { label: 'Node.js 工具链', value: 'node' },
                { label: 'Python 工具链', value: 'python' }
              ]}
            />
          </div>

          <div className="toolkit-workbench">
            <aside className="toolkit-tool-index" aria-label="环境工具目录">
              {Array.from(new Set(entries.map((entry) => entry.group))).map((groupId) => {
                const groupEntries = entries.filter((entry) => entry.group === groupId);
                return (
                  <div key={groupId} className="toolkit-tool-group">
                    <h3>{groupEntries[0]?.groupLabel}</h3>
                    {groupEntries.map((entry) => (
                      <button
                        key={entry.tool.id}
                        type="button"
                        className="toolkit-tool-option"
                        data-active={entry.tool.id === selectedEntry?.tool.id || undefined}
                        aria-pressed={entry.tool.id === selectedEntry?.tool.id}
                        onClick={() => setSelectedToolId(entry.tool.id)}
                      >
                        <span>
                          <strong>{entry.tool.name}</strong>
                          <small>{entry.status}</small>
                        </span>
                        <Tag color={entry.detected ? 'success' : 'default'}>
                          {entry.detected ? '已实测' : '指南'}
                        </Tag>
                      </button>
                    ))}
                  </div>
                );
              })}
            </aside>

            <div className="toolkit-workbench-detail">
              {selectedEntry ? (
                <>
                  <div className="toolkit-detail-heading">
                    <div>
                      <span>{selectedEntry.groupLabel}</span>
                      <h3>{selectedEntry.tool.name}</h3>
                    </div>
                    <div className="toolkit-detail-actions">
                      {selectedEntry.tool.recommended && <Tag color="blue">后端标记推荐</Tag>}
                      {selectedEntry.tool.platforms?.map((platform) => <Tag key={platform}>{platform}</Tag>)}
                      <Tag color={selectedEntry.detected ? 'success' : 'default'}>{selectedEntry.status}</Tag>
                    </div>
                  </div>
                  {selectedEntry.tool.installGuide && (
                    <div className="toolkit-source-note">
                      <strong>安装指南来源</strong>
                      <code>{selectedEntry.tool.installGuide}</code>
                    </div>
                  )}
                  <GuidedCommandPanel tasks={selectedTasks} />
                  <EnvironmentActionPanel
                    managerId={selectedEntry.tool.id}
                    detected={selectedEntry.detected}
                    onExecuted={fetchEnvironment}
                  />
                </>
              ) : <Empty description="没有环境工具指南" />}
            </div>
          </div>

          <section className="toolkit-faq" aria-labelledby="toolkit-environment-faq">
            <div className="toolkit-panel-kicker">FIELD NOTES</div>
            <h3 id="toolkit-environment-faq">常见问题</h3>
            <Collapse items={FAQ_ITEMS[runtime]} />
          </section>
        </>
      ) : null}
    </section>
  );
}
