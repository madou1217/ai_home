import { useEffect, useMemo, useState } from 'react';
import { CopyOutlined } from '@ant-design/icons';
import { Input, Select } from 'antd';
import {
  GUIDED_COMMAND_CATEGORY_LABELS,
  missingGuidedParameters,
  renderGuidedCommand,
  UNRESOLVED_COMMAND_PARAMETER,
  type GuidedCommandTask
} from '@/components/toolkit/guided-command';
import { useCommandCopy } from '@/components/toolkit/use-command-copy';
import { HudField } from '@/mobile/ui';
import { ActionButton, MonoBlock, Note, StatusText } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

interface Props {
  tasks: GuidedCommandTask[];
  emptyText?: string;
}

/**
 * 移动端命令生成器：选择任务 → 填写参数 → 等宽命令块 → 复制。
 * 与桌面 GuidedCommandPanel 共用同一套模板渲染 / 缺参判定 / 复制逻辑；命令只生成和复制，不会执行。
 */
export default function GuidedCommand({ tasks, emptyText = '当前工具没有可用命令指南。' }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const { copying, copy } = useCommandCopy();

  useEffect(() => {
    setSelectedId((current) => tasks.some((task) => task.id === current) ? current : (tasks[0]?.id || ''));
    setValues({});
  }, [tasks]);

  const task = useMemo(() => tasks.find((item) => item.id === selectedId) || tasks[0], [selectedId, tasks]);
  if (!task) return <p className={styles.prose}>{emptyText}</p>;

  const command = renderGuidedCommand(task.command, values);
  const missing = missingGuidedParameters(task, values);
  const unresolved = UNRESOLVED_COMMAND_PARAMETER.test(command);
  const copyDisabled = missing.length > 0 || !command.trim() || unresolved;
  const reason = missing.length > 0
    ? `请填写：${missing.map((item) => item.label).join('、')}`
    : unresolved ? '请先填写命令所需参数' : '';

  return (
    <div className={styles.guide}>
      <HudField label="我要完成">
        <Select
          value={task.id}
          onChange={(value) => {
            setSelectedId(value);
            setValues({});
          }}
          options={tasks.map((item) => ({
            value: item.id,
            label: `${GUIDED_COMMAND_CATEGORY_LABELS[item.category]} · ${item.label}`
          }))}
          aria-label="选择命令任务"
        />
      </HudField>
      {(task.parameters || []).map((parameter) => (
        <HudField key={parameter.key} label={parameter.label}>
          <Input
            value={values[parameter.key] || ''}
            placeholder={parameter.placeholder}
            onChange={(event) => setValues((current) => ({ ...current, [parameter.key]: event.target.value }))}
            aria-label={parameter.label}
          />
        </HudField>
      ))}
      <div className={styles.guideMeta}>
        <StatusText tone="info">{GUIDED_COMMAND_CATEGORY_LABELS[task.category]}</StatusText>
        {task.platform ? <StatusText tone="muted">{task.platform}</StatusText> : null}
        {task.danger ? <StatusText tone="warn">会修改本机环境</StatusText> : null}
      </div>
      {task.description ? <p className={styles.prose}>{task.description}</p> : null}
      {task.danger ? (
        <Note tone="warn">请先检查命令；当前页面只负责生成和复制，不会自动执行环境变更。</Note>
      ) : null}
      <MonoBlock label="可复制命令">{command || '等待生成命令'}</MonoBlock>
      {reason ? <span className={styles.hint}>{reason}</span> : null}
      <ActionButton
        icon={<CopyOutlined />}
        label="复制命令"
        tone={task.danger ? 'danger' : 'primary'}
        loading={copying}
        disabled={copyDisabled}
        onClick={() => void copy(command)}
      />
    </div>
  );
}
