import { useEffect, useMemo, useState } from 'react';
import { Alert, Input, Select, Tag } from 'antd';
import CopyableCommand from './CopyableCommand';

export interface GuidedCommandParameter {
  key: string;
  label: string;
  placeholder: string;
}

export interface GuidedCommandTask {
  id: string;
  label: string;
  command: string;
  category: 'install' | 'configure' | 'use' | 'uninstall' | 'inspect';
  platform?: string;
  description?: string;
  danger?: boolean;
  parameters?: GuidedCommandParameter[];
}

interface GuidedCommandPanelProps {
  tasks: GuidedCommandTask[];
  title?: string;
  emptyText?: string;
}

const CATEGORY_LABELS: Record<GuidedCommandTask['category'], string> = {
  install: '安装',
  configure: '配置',
  use: '使用',
  uninstall: '卸载',
  inspect: '检查'
};

function renderCommand(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const value = values[key]?.trim();
    return value || `{{${key}}}`;
  });
}

export default function GuidedCommandPanel({
  tasks,
  title = '任务式命令生成器',
  emptyText = '当前工具没有可用命令指南。'
}: GuidedCommandPanelProps) {
  const [selectedId, setSelectedId] = useState('');
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedId((current) => tasks.some((task) => task.id === current) ? current : (tasks[0]?.id || ''));
    setParameterValues({});
  }, [tasks]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) || tasks[0],
    [selectedId, tasks]
  );
  const renderedCommand = selectedTask
    ? renderCommand(selectedTask.command, parameterValues)
    : '';
  const missingParameters = (selectedTask?.parameters || []).filter(
    (parameter) => !parameterValues[parameter.key]?.trim()
  );

  if (!selectedTask) {
    return <div className="toolkit-empty-inline">{emptyText}</div>;
  }

  return (
    <section className="toolkit-command-guide" aria-labelledby="toolkit-command-guide-title">
      <div className="toolkit-panel-kicker">GUIDED TASK</div>
      <h3 id="toolkit-command-guide-title">{title}</h3>
      <div className="toolkit-command-controls">
        <label>
          <span>我要完成</span>
          <Select
            value={selectedTask.id}
            onChange={(value) => {
              setSelectedId(value);
              setParameterValues({});
            }}
            options={tasks.map((task) => ({
              value: task.id,
              label: `${CATEGORY_LABELS[task.category]} · ${task.label}`
            }))}
            aria-label="选择命令任务"
          />
        </label>
        {(selectedTask.parameters || []).map((parameter) => (
          <label key={parameter.key}>
            <span>{parameter.label}</span>
            <Input
              value={parameterValues[parameter.key] || ''}
              placeholder={parameter.placeholder}
              onChange={(event) => setParameterValues((current) => ({
                ...current,
                [parameter.key]: event.target.value
              }))}
              aria-label={parameter.label}
            />
          </label>
        ))}
      </div>

      <div className="toolkit-command-meta">
        <Tag>{CATEGORY_LABELS[selectedTask.category]}</Tag>
        {selectedTask.platform && <Tag>{selectedTask.platform}</Tag>}
        {selectedTask.danger && <Tag color="warning">会修改本机环境</Tag>}
      </div>
      {selectedTask.description && <p className="toolkit-command-description">{selectedTask.description}</p>}
      {selectedTask.danger && (
        <Alert
          type="warning"
          showIcon
          message="请先检查命令再复制"
          description="AIH 只生成并复制命令，不会在当前页面自动执行安装、卸载或环境变更。"
        />
      )}
      <CopyableCommand
        command={renderedCommand}
        danger={selectedTask.danger}
        disabled={missingParameters.length > 0}
        disabledReason={missingParameters.length > 0
          ? `请填写：${missingParameters.map((item) => item.label).join('、')}`
          : undefined}
      />
    </section>
  );
}
