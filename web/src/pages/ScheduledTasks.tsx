import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  TimePicker,
  Tooltip,
  message
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ProColumns } from '@ant-design/pro-components';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import PageScaffold from '@/components/ui/PageScaffold';
import Reveal from '@/components/ui/Reveal';
import SaveActionBar from '@/components/ui/SaveActionBar';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import {
  accountsAPI,
  deleteScheduledTask,
  listScheduledTaskRecords,
  listScheduledTasks,
  previewScheduledTaskSchedule,
  runScheduledTask,
  saveScheduledTask,
  toggleScheduledTask
} from '@/services/api';
import { ActivityParamFields } from '@/features/accounts/ActivityParamFields';
import { getAccountPrimaryLabel, getAccountSecondaryLabel } from '@/features/accounts/AccountBadges';
import type {
  Account,
  ActivityParamField,
  ActivityParamOption,
  ActivityProbeResult,
  ScheduledTask,
  ScheduledTaskEvent,
  ScheduledTaskRecord,
  ScheduledTaskSchedule
} from '@/types';
import dayjs from 'dayjs';
import './ScheduledTasks.css';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type TaskFilter = 'all' | 'enabled' | 'paused' | 'running' | 'failed';

type EditorState = {
  open: boolean;
  editing: ScheduledTask | null;
  eventId: string;
  name: string;
  command: string;
  cwd: string;
  /** 活动事件的抽象参数（key → 值），语义由服务端描述符声明。 */
  activityParams: Record<string, unknown>;
  scheduleKind: ScheduledTaskSchedule['kind'];
  at: string;
  weekday: number;
  hours: number;
  minutes: number;
  /** cron 表达式（原生 5 段） */
  expression: string;
  enabled: boolean;
};

const EMPTY_EDITOR: EditorState = {
  open: false,
  editing: null,
  eventId: '',
  name: '',
  command: '',
  cwd: '',
  activityParams: {},
  scheduleKind: 'daily',
  at: '20:00',
  weekday: 1,
  hours: 6,
  minutes: 0,
  expression: '0 20 * * *',
  enabled: true
};

function formatTime(timestamp: number) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isFailedStatus(status?: string) {
  const value = String(status || '').toLowerCase();
  return value === 'error' || value === 'failed';
}

function recordStatusTag(status: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'ok' || value === 'succeeded') {
    return <Tag color="green" icon={<CheckCircleOutlined />}>成功</Tag>;
  }
  if (value === 'skipped') {
    return <Tag icon={<MinusCircleOutlined />}>跳过</Tag>;
  }
  if (value === 'error' || value === 'failed') {
    return <Tag color="red" icon={<CloseCircleOutlined />}>失败</Tag>;
  }
  if (value === 'running' || value === 'queued') {
    return <Tag color="blue" icon={<LoadingOutlined spin />}>运行中</Tag>;
  }
  return <Tag icon={<MinusCircleOutlined />}>未运行</Tag>;
}

function taskStateTag(task: ScheduledTask) {
  if (task.running) {
    return <Tag color="blue" icon={<LoadingOutlined spin />}>运行中</Tag>;
  }
  if (isFailedStatus(task.lastStatus)) {
    return <Tag color="red" icon={<CloseCircleOutlined />}>失败</Tag>;
  }
  if (task.enabled === false) {
    return <Tag icon={<PauseCircleOutlined />}>暂停</Tag>;
  }
  return <Tag color="green" icon={<CheckCircleOutlined />}>启用</Tag>;
}

function describeSchedule(schedule: ScheduledTaskSchedule) {
  if (!schedule) return '未设置';
  if (schedule.kind === 'daily') return `每天 ${schedule.at}`;
  if (schedule.kind === 'weekly') return `每${WEEKDAYS[Number(schedule.weekday) || 0]} ${schedule.at}`;
  if (schedule.kind === 'cron') return schedule.expression ? `Cron: ${schedule.expression}` : 'Cron';
  const parts: string[] = [];
  if (schedule.hours) parts.push(`${schedule.hours} 小时`);
  if (schedule.minutes) parts.push(`${schedule.minutes} 分钟`);
  return `每 ${parts.join(' ') || '—'}`;
}

interface TaskEditorModalProps {
  editor: EditorState;
  events: ScheduledTaskEvent[];
  eventOptions: Array<{ value: string; label: string; disabled: boolean }>;
  selectedEvent: ScheduledTaskEvent | null;
  paramFields: ActivityParamField[];
  accountOptions: ActivityParamOption[];
  probe: ActivityProbeResult | null;
  probing: boolean;
  preview: { label: string; nextRunAt: number } | null;
  previewError: string;
  saving: boolean;
  submitError: string;
  scheduleSurfaceRef: React.RefObject<HTMLDivElement>;
  onSwitchScheduleSurface: ReturnType<typeof useSurfaceSwitch<HTMLDivElement>>['switchSurface'];
  onChangeEditor: React.Dispatch<React.SetStateAction<EditorState>>;
  onResetProbe: () => void;
  onProbe: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function TaskEditorModal({
  editor,
  events,
  eventOptions,
  selectedEvent,
  paramFields,
  accountOptions,
  probe,
  probing,
  preview,
  previewError,
  saving,
  submitError,
  scheduleSurfaceRef,
  onSwitchScheduleSurface,
  onChangeEditor,
  onResetProbe,
  onProbe,
  onCancel,
  onSubmit
}: TaskEditorModalProps) {
  const canSave = Boolean(editor.eventId) && !previewError;

  return (
    <Modal
      open={editor.open}
      title={editor.editing ? '编辑计划任务' : '新建计划任务'}
      width="min(760px, calc(100vw - 24px))"
      footer={null}
      onCancel={onCancel}
      destroyOnClose
    >
      <div className="scheduled-tasks-modal-body">
        {submitError ? <InlineNote tone="error">{submitError}</InlineNote> : null}

        <SettingSection
          title="基础配置"
          description="选择定时触发的事件与展示名称。"
        >
          <SettingRow
            title="执行事件"
            description={selectedEvent?.description || '决定定时触发时执行的具体作业。'}
            htmlFor="st-event"
            control={(
              <Select
                id="st-event"
                style={{ width: '100%' }}
                value={editor.eventId || undefined}
                placeholder="选择要定时执行的事件"
                options={eventOptions}
                onChange={(value) => {
                  const event = events.find((item) => item.id === value) || null;
                  onResetProbe();
                  onChangeEditor((prev) => ({
                    ...prev,
                    eventId: value,
                    activityParams: {},
                    name: prev.editing ? prev.name : (event ? event.label : prev.name)
                  }));
                }}
              />
            )}
          />
          <SettingRow
            title="任务名称"
            description="留空时自动沿用事件名称。"
            htmlFor="st-name"
            control={(
              <Input
                id="st-name"
                value={editor.name}
                placeholder="留空则用事件名"
                onChange={(event) => onChangeEditor((prev) => ({ ...prev, name: event.target.value }))}
              />
            )}
          />
          <SettingRow
            title="任务状态"
            description="暂停后保留配置，但不按调度自动触发。"
            htmlFor="st-enabled"
            control={(
              <Switch
                id="st-enabled"
                checked={editor.enabled}
                checkedChildren="启用"
                unCheckedChildren="暂停"
                onChange={(checked) => onChangeEditor((prev) => ({ ...prev, enabled: checked }))}
              />
            )}
          />
        </SettingSection>

        <Reveal open={selectedEvent?.kind === 'custom'}>
          <SettingSection
            title="命令参数"
            description="命令以服务进程身份在宿主环境执行。"
          >
            <SettingRow
              title="执行命令"
              description="支持多行脚本或单行 CLI 命令。"
              htmlFor="st-command"
              layout="stacked"
              control={(
                <Input.TextArea
                  id="st-command"
                  rows={3}
                  value={editor.command}
                  placeholder="例如：echo hello"
                  onChange={(event) => onChangeEditor((prev) => ({ ...prev, command: event.target.value }))}
                />
              )}
            />
            <SettingRow
              title="工作目录"
              description="可选，留空使用服务默认目录。"
              htmlFor="st-cwd"
              control={(
                <Input
                  id="st-cwd"
                  value={editor.cwd}
                  placeholder="例如：/srv/aih"
                  onChange={(event) => onChangeEditor((prev) => ({ ...prev, cwd: event.target.value }))}
                />
              )}
            />
          </SettingSection>
        </Reveal>

        <Reveal open={selectedEvent?.kind === 'activity'}>
          {selectedEvent ? (
            <SettingSection
              title="活动参数"
              description="限定本次签到或活动作业的账号与类型范围；留空表示不限。"
            >
              <div className="scheduled-tasks-activity-wrap">
                <ActivityParamFields
                  fields={paramFields}
                  value={editor.activityParams}
                  onChange={(next) => onChangeEditor((prev) => ({ ...prev, activityParams: next }))}
                  accountOptions={accountOptions}
                  probe={probe}
                  probing={probing}
                  onProbe={selectedEvent.supportsProbe ? onProbe : undefined}
                />
              </div>
            </SettingSection>
          ) : null}
        </Reveal>

        <SettingSection
          title="调度周期"
          description="设置触发频率；服务端实时校验表达式并计算下次运行时间。"
          footer={(
            <SaveActionBar
              dirty={canSave}
              saving={saving}
              disabled={!canSave}
              onSave={onSubmit}
              saveLabel={editor.editing ? '保存任务' : '创建任务'}
              cleanSaveLabel={previewError ? '调度无效' : '请选择事件'}
              effectSummary="保存后立即同步到调度器"
              feedback={submitError || undefined}
              feedbackTone={submitError ? 'error' : 'muted'}
              extraActions={(
                <Button disabled={saving} onClick={onCancel}>取消</Button>
              )}
            />
          )}
        >
          <SettingRow
            title="触发规则"
            description="支持每天、每周、固定间隔或 5 段 Cron 表达式。"
            layout="stacked"
            control={(
              <div className="scheduled-tasks-schedule-control">
                <Space size={8} wrap>
                  <Select
                    style={{ width: 132 }}
                    value={editor.scheduleKind}
                    onChange={(value) => {
                      const kindOrder = ['daily', 'weekly', 'interval', 'cron'] as const;
                      onSwitchScheduleSurface(() => {
                        onChangeEditor((prev) => ({ ...prev, scheduleKind: value }));
                      }, {
                        current: editor.scheduleKind,
                        next: value,
                        direction: resolveOrderedDirection(kindOrder, editor.scheduleKind, value)
                      });
                    }}
                    options={[
                      { value: 'daily', label: '每天' },
                      { value: 'weekly', label: '每周' },
                      { value: 'interval', label: '按间隔' },
                      { value: 'cron', label: 'Cron 表达式' }
                    ]}
                  />
                  <div ref={scheduleSurfaceRef} className="scheduled-tasks-schedule-fields">
                    {editor.scheduleKind === 'weekly' ? (
                      <Select
                        style={{ width: 108 }}
                        value={editor.weekday}
                        onChange={(value) => onChangeEditor((prev) => ({ ...prev, weekday: Number(value) }))}
                        options={WEEKDAYS.map((label, index) => ({ value: index, label }))}
                      />
                    ) : null}
                    {editor.scheduleKind === 'interval' ? (
                      <>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          style={{ width: 112 }}
                          value={editor.hours}
                          addonAfter="小时"
                          onChange={(event) => onChangeEditor((prev) => ({ ...prev, hours: Number(event.target.value) }))}
                        />
                        <Input
                          type="number"
                          min={0}
                          max={59}
                          style={{ width: 112 }}
                          value={editor.minutes}
                          addonAfter="分钟"
                          onChange={(event) => onChangeEditor((prev) => ({ ...prev, minutes: Number(event.target.value) }))}
                        />
                      </>
                    ) : editor.scheduleKind === 'cron' ? (
                      <Input
                        style={{ width: 240, maxWidth: '100%' }}
                        value={editor.expression}
                        placeholder="分 时 日 月 周，例如 0 20 * * *"
                        onChange={(event) => onChangeEditor((prev) => ({ ...prev, expression: event.target.value }))}
                      />
                    ) : (
                      <TimePicker
                        format="HH:mm"
                        minuteStep={5}
                        value={dayjs(editor.at, 'HH:mm')}
                        onChange={(value) => onChangeEditor((prev) => ({
                          ...prev,
                          at: value ? value.format('HH:mm') : prev.at
                        }))}
                      />
                    )}
                  </div>
                </Space>
                {previewError ? (
                  <InlineNote tone="error">无法识别该调度：{previewError}</InlineNote>
                ) : preview ? (
                  <div className="scheduled-tasks-preview">
                    {preview.label} · 下次运行 {formatTime(preview.nextRunAt)}
                  </div>
                ) : null}
              </div>
            )}
          />
        </SettingSection>
      </div>
    </Modal>
  );
}

export default function ScheduledTasks() {
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [events, setEvents] = useState<ScheduledTaskEvent[]>([]);
  const [records, setRecords] = useState<ScheduledTaskRecord[]>([]);
  const [recordDays, setRecordDays] = useState(7);
  const [recordPage, setRecordPage] = useState(1);
  const [recordPageSize, setRecordPageSize] = useState(20);
  const [recordTotal, setRecordTotal] = useState(0);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [savingEditor, setSavingEditor] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [busyId, setBusyId] = useState('');
  const { surfaceRef: recordsSurfaceRef, switchSurface: switchRecordsSurface } = useSurfaceSwitch<HTMLDivElement>();
  const { surfaceRef: scheduleSurfaceRef, switchSurface: switchScheduleSurface } = useSurfaceSwitch<HTMLDivElement>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [tasksResponse, recordsResponse] = await Promise.all([
        listScheduledTasks(),
        listScheduledTaskRecords(recordDays, '', {
          limit: recordPageSize,
          offset: (recordPage - 1) * recordPageSize
        })
      ]);
      setTasks(Array.isArray(tasksResponse.tasks) ? tasksResponse.tasks : []);
      setEvents(Array.isArray(tasksResponse.events) ? tasksResponse.events : []);
      setSchedulerRunning(Boolean(tasksResponse.schedulerRunning));
      setRecords(Array.isArray(recordsResponse.records) ? recordsResponse.records : []);
      setRecordTotal(Number(recordsResponse.total || 0));
    } catch (_error) {
      setLoadError('读取计划任务失败，请确认网关服务正常运行后重试。');
    } finally {
      setLoading(false);
    }
  }, [recordDays, recordPage, recordPageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleTaskCompleted = () => {
      void load();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [load]);

  useEffect(() => {
    setRecordPage(1);
  }, [recordDays]);

  const eventOptions = useMemo(() => (
    events.map((event) => ({
      value: event.id,
      label: event.available === false ? `${event.label}（当前不可用）` : event.label,
      disabled: event.available === false
    }))
  ), [events]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === editor.eventId) || null,
    [editor.eventId, events]
  );

  const taskStats = useMemo(() => {
    let enabled = 0;
    let paused = 0;
    let running = 0;
    let failed = 0;
    for (const task of tasks) {
      if (task.enabled === false) paused += 1;
      else enabled += 1;
      if (task.running) running += 1;
      if (isFailedStatus(task.lastStatus)) failed += 1;
    }
    return { total: tasks.length, enabled, paused, running, failed };
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return tasks.filter((task) => {
      if (taskFilter === 'enabled' && task.enabled === false) return false;
      if (taskFilter === 'paused' && task.enabled !== false) return false;
      if (taskFilter === 'running' && !task.running) return false;
      if (taskFilter === 'failed' && !isFailedStatus(task.lastStatus)) return false;
      if (!keyword) return true;
      return `${task.name} ${task.eventLabel} ${describeSchedule(task.schedule)}`.toLowerCase().includes(keyword);
    });
  }, [tasks, taskFilter, searchText]);

  const [accountOptions, setAccountOptions] = useState<ActivityParamOption[]>([]);
  const [paramFields, setParamFields] = useState<ActivityParamField[]>([]);
  const [probe, setProbe] = useState<ActivityProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const isActivityEvent = selectedEvent?.kind === 'activity';

  useEffect(() => {
    if (!editor.open || !isActivityEvent || accountOptions.length > 0) return undefined;
    let cancelled = false;
    void accountsAPI.list()
      .then((result) => {
        if (cancelled) return;
        const provider = selectedEvent?.provider || '';
        const options = (result.accounts || [])
          .filter((account: Account) => !provider || account.provider === provider)
          .map((account: Account) => ({
            value: account.accountRef,
            label: getAccountPrimaryLabel(account),
            description: getAccountSecondaryLabel(account)
          }))
          .filter((option) => option.value);
        setAccountOptions(options);
      })
      .catch(() => { /* 账号列表拉不到时仍可留空 = 全部账号 */ });
    return () => { cancelled = true; };
  }, [editor.open, isActivityEvent, accountOptions.length, selectedEvent?.provider]);

  useEffect(() => {
    if (!editor.open || !isActivityEvent || !selectedEvent?.provider || !selectedEvent.actionId) {
      setParamFields([]);
      return undefined;
    }
    let cancelled = false;
    void accountsAPI.listActivityParamOptions({
      provider: selectedEvent.provider,
      actionId: selectedEvent.actionId
    })
      .then((result) => {
        if (cancelled) return;
        setParamFields(result.ok && result.params.length > 0 ? result.params : (selectedEvent.params || []));
      })
      .catch(() => {
        if (!cancelled) setParamFields(selectedEvent.params || []);
      });
    return () => { cancelled = true; };
  }, [editor.open, isActivityEvent, selectedEvent?.provider, selectedEvent?.actionId, selectedEvent?.params]);

  const handleProbe = useCallback(async () => {
    if (!selectedEvent?.provider || !selectedEvent.actionId) return;
    setProbing(true);
    try {
      const result = await accountsAPI.probeAccountActivity({
        providers: [selectedEvent.provider],
        actionId: selectedEvent.actionId
      });
      setProbe(result);
      if (!result.ok) message.error(`探测失败：${result.error || 'unknown'}`);
      else if ((result.kinds || []).length === 0) message.info('探测完成：当前没有可领类型');
    } catch (_error) {
      message.error('探测失败：请求异常');
    } finally {
      setProbing(false);
    }
  }, [selectedEvent?.provider, selectedEvent?.actionId]);

  const [preview, setPreview] = useState<{ label: string; nextRunAt: number } | null>(null);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    if (!editor.open) return undefined;
    const schedule: ScheduledTaskSchedule = editor.scheduleKind === 'interval'
      ? { kind: 'interval', hours: Number(editor.hours) || 0, minutes: Number(editor.minutes) || 0 }
      : editor.scheduleKind === 'weekly'
        ? { kind: 'weekly', weekday: Number(editor.weekday), at: editor.at }
        : editor.scheduleKind === 'cron'
          ? { kind: 'cron', expression: editor.expression.trim() }
          : { kind: 'daily', at: editor.at };
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await previewScheduledTaskSchedule(schedule);
        if (cancelled) return;
        if (result.ok) {
          setPreview({ label: result.label || '', nextRunAt: Number(result.nextRunAt || 0) });
          setPreviewError('');
        } else {
          setPreview(null);
          setPreviewError(result.error || 'schedule_invalid');
        }
      } catch (_error) {
        if (!cancelled) setPreviewError('preview_failed');
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editor.open, editor.scheduleKind, editor.at, editor.weekday, editor.hours, editor.minutes, editor.expression]);

  const [recordsTask, setRecordsTask] = useState<ScheduledTask | null>(null);
  const [taskRecords, setTaskRecords] = useState<ScheduledTaskRecord[]>([]);
  const [taskRecordsLoading, setTaskRecordsLoading] = useState(false);
  const [taskRecordsPage, setTaskRecordsPage] = useState(1);
  const [taskRecordsPageSize, setTaskRecordsPageSize] = useState(10);
  const [taskRecordsTotal, setTaskRecordsTotal] = useState(0);

  const loadTaskRecords = useCallback(async (
    task: ScheduledTask,
    page: number,
    pageSize: number
  ) => {
    setTaskRecordsLoading(true);
    try {
      const result = await listScheduledTaskRecords(recordDays, task.id, {
        limit: pageSize,
        offset: (page - 1) * pageSize
      });
      setTaskRecords(Array.isArray(result.records) ? result.records : []);
      setTaskRecordsTotal(Number(result.total || 0));
    } catch (_error) {
      setTaskRecords([]);
      setTaskRecordsTotal(0);
      message.error('读取该任务的执行记录失败');
    } finally {
      setTaskRecordsLoading(false);
    }
  }, [recordDays]);

  const openTaskRecords = useCallback(async (task: ScheduledTask) => {
    setRecordsTask(task);
    setTaskRecordsPage(1);
    await loadTaskRecords(task, 1, taskRecordsPageSize);
  }, [loadTaskRecords, taskRecordsPageSize]);

  const openCreate = () => {
    const first = events.find((event) => event.available !== false) || null;
    setProbe(null);
    setEditorError('');
    setEditor({
      ...EMPTY_EDITOR,
      open: true,
      eventId: first ? first.id : '',
      name: first ? first.label : ''
    });
  };

  const openEdit = (task: ScheduledTask) => {
    const schedule = task.schedule || { kind: 'daily', at: '20:00' };
    const rawParams = task.eventParams || {};
    const activityParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawParams)) {
      if (key === 'command' || key === 'cwd') continue;
      activityParams[key] = value;
    }
    setProbe(null);
    setEditorError('');
    setEditor({
      open: true,
      editing: task,
      eventId: task.eventId,
      name: task.name,
      command: String(rawParams.command || ''),
      cwd: String(rawParams.cwd || ''),
      activityParams,
      scheduleKind: schedule.kind,
      at: schedule.at || '20:00',
      weekday: Number(schedule.weekday ?? 1),
      hours: Number(schedule.hours ?? 6),
      minutes: Number(schedule.minutes ?? 0),
      expression: schedule.expression || '0 20 * * *',
      enabled: task.enabled !== false
    });
  };

  const buildActivityEventParams = () => {
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(editor.activityParams)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      params[key] = value;
    }
    return params;
  };

  const submitEditor = async () => {
    if (!editor.eventId) {
      setEditorError('请选择要定时执行的事件');
      return;
    }
    const schedule: ScheduledTaskSchedule = editor.scheduleKind === 'interval'
      ? { kind: 'interval', hours: Number(editor.hours) || 0, minutes: Number(editor.minutes) || 0 }
      : editor.scheduleKind === 'weekly'
        ? { kind: 'weekly', weekday: Number(editor.weekday), at: editor.at }
        : editor.scheduleKind === 'cron'
          ? { kind: 'cron', expression: editor.expression.trim() }
          : { kind: 'daily', at: editor.at };
    const eventParams = selectedEvent?.kind === 'custom'
      ? { command: editor.command.trim(), ...(editor.cwd.trim() ? { cwd: editor.cwd.trim() } : {}) }
      : selectedEvent?.kind === 'activity'
        ? buildActivityEventParams()
        : {};
    setSavingEditor(true);
    setEditorError('');
    try {
      const result = await saveScheduledTask({
        ...(editor.editing ? { id: editor.editing.id } : {}),
        name: editor.name.trim() || (selectedEvent ? selectedEvent.label : ''),
        eventId: editor.eventId,
        eventParams,
        schedule,
        enabled: editor.enabled
      } as Partial<ScheduledTask> & { eventId: string; schedule: ScheduledTaskSchedule });
      if (!result.ok) {
        setEditorError(`保存失败：${result.error || 'unknown'}`);
        return;
      }
      setEditor(EMPTY_EDITOR);
      message.success('计划任务已保存');
      void load();
    } catch (error) {
      setEditorError(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
    } finally {
      setSavingEditor(false);
    }
  };

  const handleRun = async (task: ScheduledTask) => {
    setBusyId(task.id);
    try {
      const result = await runScheduledTask(task.id);
      if (!result.ok) message.error(`执行失败：${result.error || 'unknown'}`);
      else message.success('已触发执行，进度可在任务队列查看');
      void load();
    } finally {
      setBusyId('');
    }
  };

  const handleToggle = async (task: ScheduledTask, enabled: boolean) => {
    const result = await toggleScheduledTask(task.id, enabled);
    if (!result.ok) {
      message.error(`操作失败：${result.error || 'unknown'}`);
      return;
    }
    void load();
  };

  const handleDelete = async (task: ScheduledTask) => {
    const result = await deleteScheduledTask(task.id);
    if (!result.ok) {
      message.error(`删除失败：${result.error || 'unknown'}`);
      return;
    }
    message.success('已删除');
    void load();
  };

  const taskColumns: ColumnsType<ScheduledTask> = [
    {
      title: '任务',
      dataIndex: 'name',
      width: 140,
      render: (_value, task) => (
        <div className="scheduled-tasks-name">
          <strong>{task.name}</strong>
          <span>{task.eventLabel}</span>
        </div>
      )
    },
    {
      title: '调度',
      width: 110,
      render: (_value, task) => <span className="scheduled-tasks-mono">{describeSchedule(task.schedule)}</span>
    },
    {
      title: '状态',
      width: 150,
      render: (_value, task) => (
        <Space size={8}>
          <Switch
            size="small"
            checked={task.enabled !== false}
            checkedChildren="启用"
            unCheckedChildren="暂停"
            onChange={(checked) => void handleToggle(task, checked)}
          />
          {taskStateTag(task)}
        </Space>
      )
    },
    {
      title: '下次运行',
      width: 110,
      render: (_value, task) => (
        <span className="scheduled-tasks-mono">
          {task.enabled === false ? '已暂停' : formatTime(task.nextRunAt)}
        </span>
      )
    },
    {
      title: '上次运行',
      width: 120,
      render: (_value, task) => (
        <Tooltip title={task.lastSummary || ''}>
          <span className="scheduled-tasks-mono">{formatTime(task.lastRunAt)}</span>
        </Tooltip>
      )
    },
    {
      title: '操作',
      width: 235,
      render: (_value, task) => (
        <Space size={4}>
          <Button
            size="small"
            title="立即执行"
            loading={busyId === task.id}
            disabled={task.running}
            onClick={() => void handleRun(task)}
          >
            执行
          </Button>
          <Button size="small" onClick={() => void openTaskRecords(task)}>记录</Button>
          <Button size="small" onClick={() => openEdit(task)}>编辑</Button>
          <Popconfirm title="删除该计划任务？" onConfirm={() => void handleDelete(task)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const recordColumns: ColumnsType<ScheduledTaskRecord> = [
    { title: '时间', width: 120, render: (_value: unknown, row: ScheduledTaskRecord) => <span className="scheduled-tasks-mono">{formatTime(row.startedAt)}</span> },
    { title: '任务', dataIndex: 'taskName', width: 160 },
    { title: '事件', dataIndex: 'eventLabel', width: 140 },
    { title: '触发', width: 72, render: (_value: unknown, row: ScheduledTaskRecord) => (row.trigger === 'schedule' ? '定时' : '手动') },
    { title: '结果', width: 96, render: (_value: unknown, row: ScheduledTaskRecord) => recordStatusTag(row.status) },
    {
      title: '摘要',
      render: (_value, row) => (
        <span className="scheduled-tasks-summary">
          {row.errorSummary || row.error || row.summary || '—'}
        </span>
      )
    }
  ];

  return (
    <PageScaffold
      ghost
      code="SCHEDULE"
      className="scheduled-tasks-page"
      title="计划任务"
      subTitle="统一编排定时活动签到与自动化命令，并跟踪执行结果。"
      extra={(
        <Space size={8} wrap>
          <SettingStatusTag
            status={schedulerRunning ? 'applied' : 'unset'}
            label={schedulerRunning ? '调度器运行中' : '调度器未启动'}
            compact
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划任务</Button>
        </Space>
      )}
    >
      <div className="scheduled-tasks-kpi-bar" aria-label="计划任务概览">
        <div className="scheduled-tasks-kpi-cell">
          <span>全部任务</span>
          <strong>{taskStats.total}</strong>
        </div>
        <div className="scheduled-tasks-kpi-cell">
          <span>启用</span>
          <strong>{taskStats.enabled}</strong>
        </div>
        <div className="scheduled-tasks-kpi-cell">
          <span>暂停</span>
          <strong>{taskStats.paused}</strong>
        </div>
        <div className="scheduled-tasks-kpi-cell">
          <span>运行中</span>
          <strong>{taskStats.running}</strong>
        </div>
        <div className="scheduled-tasks-kpi-cell">
          <span>最近失败</span>
          <strong>{taskStats.failed}</strong>
        </div>
      </div>

      {loadError ? (
        <InlineNote
          tone="error"
          style={{ marginBottom: 16 }}
          action={<Button size="small" type="link" onClick={() => void load()}>重试</Button>}
        >
          {loadError}
        </InlineNote>
      ) : null}

      <SectionCard
        title="任务列表"
        extra={(
          <div className="scheduled-tasks-filters">
            <Segmented
              size="small"
              value={taskFilter}
              onChange={(value) => setTaskFilter(value as TaskFilter)}
              options={[
                { label: `全部 ${taskStats.total}`, value: 'all' },
                { label: `启用 ${taskStats.enabled}`, value: 'enabled' },
                { label: `暂停 ${taskStats.paused}`, value: 'paused' },
                { label: `运行中 ${taskStats.running}`, value: 'running' },
                { label: `失败 ${taskStats.failed}`, value: 'failed' }
              ]}
            />
            <Input
              allowClear
              size="small"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="筛选名称或事件"
              className="scheduled-tasks-search"
            />
          </div>
        )}
      >
        {tasks.length === 0 ? (
          <HudStateView
            compact
            code="NO_SCHEDULES"
            title="还没有计划任务"
            description="配置按日、按周、固定间隔或 Cron 触发的自动作业。"
            extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划任务</Button>}
          />
        ) : filteredTasks.length === 0 ? (
          <HudStateView
            compact
            code="NO_MATCH"
            title="当前筛选下无任务"
            description="清空状态或关键词筛选即可查看全部任务。"
            extra={(
              <Button
                onClick={() => {
                  setTaskFilter('all');
                  setSearchText('');
                }}
              >
                重置筛选
              </Button>
            )}
          />
        ) : (
          <ListTable<ScheduledTask>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={filteredTasks}
            columns={taskColumns as unknown as ProColumns<ScheduledTask>[]}
            pagination={{ pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 个任务` }}
          />
        )}
      </SectionCard>

      <SectionCard
        title="运行记录"
        extra={(
          <Space size={8} wrap>
            <span className="scheduled-tasks-hint">实时进度见右下角队列 · 窗口</span>
            <Select
              size="small"
              value={recordDays}
              style={{ width: 92 }}
              onChange={(value) => {
                const nextDays = Number(value);
                const dayOrder = [1, 3, 7, 14] as const;
                switchRecordsSurface(() => setRecordDays(nextDays), {
                  slot: 'recordDays',
                  current: recordDays,
                  next: nextDays,
                  direction: resolveOrderedDirection(dayOrder, recordDays as 1 | 3 | 7 | 14, nextDays as 1 | 3 | 7 | 14)
                });
              }}
              options={[
                { value: 1, label: '最近 1 天' },
                { value: 3, label: '最近 3 天' },
                { value: 7, label: '最近 7 天' },
                { value: 14, label: '最近 14 天' }
              ]}
            />
          </Space>
        )}
      >
        <div ref={recordsSurfaceRef}>
          {records.length === 0 ? (
            <HudStateView compact code="NO_LOGS" title={`最近 ${recordDays} 天暂无运行记录`} />
          ) : (
            <ListTable<ScheduledTaskRecord>
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={records}
              columns={recordColumns as unknown as ProColumns<ScheduledTaskRecord>[]}
              pagination={{
                current: recordPage,
                pageSize: recordPageSize,
                total: recordTotal,
                pageSizeOptions: [20, 50, 100],
                showTotal: (total) => `共 ${total} 条记录`,
                onChange: (page, pageSize) => {
                  switchRecordsSurface(() => {
                    setRecordPage(page);
                    if (pageSize !== recordPageSize) setRecordPageSize(pageSize);
                  }, {
                    direction: page > recordPage ? 'forward' : page < recordPage ? 'backward' : 'neutral'
                  });
                }
              }}
            />
          )}
        </div>
      </SectionCard>

      <TaskEditorModal
        editor={editor}
        events={events}
        eventOptions={eventOptions}
        selectedEvent={selectedEvent}
        paramFields={paramFields}
        accountOptions={accountOptions}
        probe={probe}
        probing={probing}
        preview={preview}
        previewError={previewError}
        saving={savingEditor}
        submitError={editorError}
        scheduleSurfaceRef={scheduleSurfaceRef}
        onSwitchScheduleSurface={switchScheduleSurface}
        onChangeEditor={setEditor}
        onResetProbe={() => setProbe(null)}
        onProbe={() => void handleProbe()}
        onCancel={() => {
          setEditor(EMPTY_EDITOR);
          setEditorError('');
        }}
        onSubmit={() => void submitEditor()}
      />

      <Modal
        open={Boolean(recordsTask)}
        title={recordsTask ? `执行记录 · ${recordsTask.name}` : '执行记录'}
        footer={null}
        width="min(760px, calc(100vw - 24px))"
        onCancel={() => setRecordsTask(null)}
      >
        {taskRecords.length === 0 ? (
          <HudStateView
            compact
            variant={taskRecordsLoading ? 'loading' : 'empty'}
            code={taskRecordsLoading ? 'SYS // LOADING' : 'NO_TASK_LOGS'}
            title={taskRecordsLoading ? '正在读取执行记录…' : `最近 ${recordDays} 天没有执行记录`}
          />
        ) : (
          <ListTable<ScheduledTaskRecord>
            rowKey="id"
            size="small"
            dataSource={taskRecords}
            columns={[
              { title: '时间', width: 120, render: (_value: unknown, row: ScheduledTaskRecord) => <span className="scheduled-tasks-mono">{formatTime(row.startedAt)}</span> },
              { title: '触发', width: 72, render: (_value: unknown, row: ScheduledTaskRecord) => (row.trigger === 'schedule' ? '定时' : '手动') },
              { title: '结果', width: 96, render: (_value: unknown, row: ScheduledTaskRecord) => recordStatusTag(row.status) },
              {
                title: '摘要',
                render: (_value: unknown, row: ScheduledTaskRecord) => (
                  <span className="scheduled-tasks-summary">
                    {row.errorSummary || row.error || row.summary || '—'}
                  </span>
                )
              }
            ] as unknown as ProColumns<ScheduledTaskRecord>[]}
            pagination={{
              current: taskRecordsPage,
              pageSize: taskRecordsPageSize,
              total: taskRecordsTotal,
              pageSizeOptions: [10, 20, 50],
              showTotal: (total) => `共 ${total} 条记录`,
              onChange: (page, pageSize) => {
                if (!recordsTask) return;
                setTaskRecordsPage(page);
                if (pageSize !== taskRecordsPageSize) setTaskRecordsPageSize(pageSize);
                void loadTaskRecords(recordsTask, page, pageSize);
              }
            }}
          />
        )}
      </Modal>
    </PageScaffold>
  );
}
