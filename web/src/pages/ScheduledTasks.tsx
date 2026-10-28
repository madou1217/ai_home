import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  message
} from 'antd';
import {
  deleteScheduledTask,
  listScheduledTaskRecords,
  listScheduledTasks,
  runScheduledTask,
  saveScheduledTask,
  toggleScheduledTask
} from '@/services/api';
import type {
  ScheduledTask,
  ScheduledTaskEvent,
  ScheduledTaskRecord,
  ScheduledTaskSchedule
} from '@/types';
import dayjs from 'dayjs';
import './ScheduledTasks.css';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

type EditorState = {
  open: boolean;
  editing: ScheduledTask | null;
  eventId: string;
  name: string;
  command: string;
  cwd: string;
  scheduleKind: ScheduledTaskSchedule['kind'];
  at: string;
  weekday: number;
  hours: number;
  minutes: number;
  enabled: boolean;
};

const EMPTY_EDITOR: EditorState = {
  open: false,
  editing: null,
  eventId: '',
  name: '',
  command: '',
  cwd: '',
  scheduleKind: 'daily',
  at: '20:00',
  weekday: 1,
  hours: 6,
  minutes: 0,
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

function statusTag(status: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'ok' || value === 'succeeded') return <Tag color="green">成功</Tag>;
  if (value === 'skipped') return <Tag>跳过</Tag>;
  if (value === 'error' || value === 'failed') return <Tag color="red">失败</Tag>;
  if (value === 'running' || value === 'queued') return <Tag color="blue">执行中</Tag>;
  return <Tag>—</Tag>;
}

function describeSchedule(schedule: ScheduledTaskSchedule) {
  if (!schedule) return '未设置';
  if (schedule.kind === 'daily') return `每天 ${schedule.at}`;
  if (schedule.kind === 'weekly') return `每${WEEKDAYS[Number(schedule.weekday) || 0]} ${schedule.at}`;
  const parts: string[] = [];
  if (schedule.hours) parts.push(`${schedule.hours} 小时`);
  if (schedule.minutes) parts.push(`${schedule.minutes} 分钟`);
  return `每 ${parts.join(' ') || '—'}`;
}

export default function ScheduledTasks() {
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [events, setEvents] = useState<ScheduledTaskEvent[]>([]);
  const [records, setRecords] = useState<ScheduledTaskRecord[]>([]);
  const [recordDays, setRecordDays] = useState(7);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tasksResponse, recordsResponse] = await Promise.all([
        listScheduledTasks(),
        listScheduledTaskRecords(recordDays)
      ]);
      setTasks(Array.isArray(tasksResponse.tasks) ? tasksResponse.tasks : []);
      setEvents(Array.isArray(tasksResponse.events) ? tasksResponse.events : []);
      setSchedulerRunning(Boolean(tasksResponse.schedulerRunning));
      setRecords(Array.isArray(recordsResponse.records) ? recordsResponse.records : []);
    } catch (_error) {
      message.error('读取计划任务失败');
    } finally {
      setLoading(false);
    }
  }, [recordDays]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => { void load(); }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

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

  const openCreate = () => {
    const first = events.find((event) => event.available !== false) || null;
    setEditor({
      ...EMPTY_EDITOR,
      open: true,
      eventId: first ? first.id : '',
      name: first ? first.label : ''
    });
  };

  const openEdit = (task: ScheduledTask) => {
    const schedule = task.schedule || { kind: 'daily', at: '20:00' };
    setEditor({
      open: true,
      editing: task,
      eventId: task.eventId,
      name: task.name,
      command: String((task.eventParams || {}).command || ''),
      cwd: String((task.eventParams || {}).cwd || ''),
      scheduleKind: schedule.kind,
      at: schedule.at || '20:00',
      weekday: Number(schedule.weekday ?? 1),
      hours: Number(schedule.hours ?? 6),
      minutes: Number(schedule.minutes ?? 0),
      enabled: task.enabled !== false
    });
  };

  const submitEditor = async () => {
    if (!editor.eventId) {
      message.warning('请选择事件');
      return;
    }
    const schedule: ScheduledTaskSchedule = editor.scheduleKind === 'interval'
      ? { kind: 'interval', hours: Number(editor.hours) || 0, minutes: Number(editor.minutes) || 0 }
      : editor.scheduleKind === 'weekly'
        ? { kind: 'weekly', weekday: Number(editor.weekday), at: editor.at }
        : { kind: 'daily', at: editor.at };
    const eventParams = selectedEvent?.kind === 'custom'
      ? { command: editor.command.trim(), ...(editor.cwd.trim() ? { cwd: editor.cwd.trim() } : {}) }
      : {};
    const result = await saveScheduledTask({
      ...(editor.editing ? { id: editor.editing.id } : {}),
      name: editor.name.trim() || (selectedEvent ? selectedEvent.label : ''),
      eventId: editor.eventId,
      eventParams,
      schedule,
      enabled: editor.enabled
    } as Partial<ScheduledTask> & { eventId: string; schedule: ScheduledTaskSchedule });
    if (!result.ok) {
      message.error(`保存失败：${result.error || 'unknown'}`);
      return;
    }
    setEditor(EMPTY_EDITOR);
    message.success('已保存');
    void load();
  };

  const handleRun = async (task: ScheduledTask) => {
    setBusyId(task.id);
    try {
      const result = await runScheduledTask(task.id);
      if (!result.ok) message.error(`执行失败：${result.error || 'unknown'}`);
      else message.success('已开始执行（进度见右下角任务队列）');
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

  return (
    <div className="scheduled-tasks-page">
      <div className="scheduled-tasks-head">
        <div>
          <h2>计划任务</h2>
          <p>
            把「签到 / 领臭鸡蛋」这类事件排成定时任务；执行进度在右下角任务队列里实时可见，
            历史结果保留最近 {recordDays} 天。
          </p>
        </div>
        <Space>
          <span className={`scheduled-tasks-scheduler is-${schedulerRunning ? 'on' : 'off'}`}>
            {schedulerRunning ? '调度器运行中' : '调度器未启动'}
          </span>
          <Button onClick={() => void load()} loading={loading}>刷新</Button>
          <Button type="primary" onClick={openCreate}>新建计划任务</Button>
        </Space>
      </div>

      <Card size="small" title="任务列表">
        {tasks.length === 0 ? (
          <Empty description="还没有计划任务" />
        ) : (
          <Table<ScheduledTask>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={tasks}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (_value, task) => (
                  <div className="scheduled-tasks-name">
                    <strong>{task.name}</strong>
                    <span>{task.eventLabel}</span>
                  </div>
                )
              },
              { title: '调度', render: (_value, task) => describeSchedule(task.schedule) },
              {
                title: '状态',
                render: (_value, task) => (
                  <Space size={6}>
                    <Switch
                      size="small"
                      checked={task.enabled !== false}
                      onChange={(checked) => void handleToggle(task, checked)}
                    />
                    {task.running ? <Tag color="blue">执行中</Tag> : statusTag(task.lastStatus)}
                  </Space>
                )
              },
              {
                title: '下次运行',
                render: (_value, task) => (task.enabled === false ? '已停用' : formatTime(task.nextRunAt))
              },
              {
                title: '上次运行',
                render: (_value, task) => (
                  <Tooltip title={task.lastSummary || ''}>
                    <span>{formatTime(task.lastRunAt)}</span>
                  </Tooltip>
                )
              },
              {
                title: '操作',
                render: (_value, task) => (
                  <Space size={4}>
                    <Button
                      size="small"
                      loading={busyId === task.id}
                      disabled={task.running}
                      onClick={() => void handleRun(task)}
                    >
                      立即执行
                    </Button>
                    <Button size="small" onClick={() => openEdit(task)}>编辑</Button>
                    <Popconfirm title="删除该计划任务？" onConfirm={() => void handleDelete(task)}>
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                )
              }
            ]}
          />
        )}
      </Card>

      <Card
        size="small"
        title="运行记录"
        extra={(
          <Space size={6}>
            <span className="scheduled-tasks-hint">显示最近</span>
            <Select
              size="small"
              value={recordDays}
              style={{ width: 96 }}
              onChange={(value) => setRecordDays(Number(value))}
              options={[
                { value: 1, label: '1 天' },
                { value: 3, label: '3 天' },
                { value: 7, label: '7 天' },
                { value: 14, label: '14 天' }
              ]}
            />
          </Space>
        )}
      >
        {records.length === 0 ? (
          <Empty description="暂无运行记录" />
        ) : (
          <Table<ScheduledTaskRecord>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            dataSource={records}
            columns={[
              { title: '时间', render: (_value, row) => formatTime(row.startedAt) },
              { title: '任务', dataIndex: 'taskName' },
              { title: '事件', dataIndex: 'eventLabel' },
              { title: '触发', render: (_value, row) => (row.trigger === 'schedule' ? '定时' : '手动') },
              { title: '结果', render: (_value, row) => statusTag(row.status) },
              {
                title: '摘要',
                render: (_value, row) => (
                  <span className="scheduled-tasks-summary">{row.error || row.summary || '—'}</span>
                )
              }
            ]}
          />
        )}
      </Card>

      <Modal
        open={editor.open}
        title={editor.editing ? '编辑计划任务' : '新建计划任务'}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEditor(EMPTY_EDITOR)}
        onOk={() => void submitEditor()}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="事件">
            <Select
              value={editor.eventId || undefined}
              placeholder="选择要定时执行的事件"
              options={eventOptions}
              onChange={(value) => {
                const event = events.find((item) => item.id === value) || null;
                setEditor((prev) => ({
                  ...prev,
                  eventId: value,
                  name: prev.editing ? prev.name : (event ? event.label : prev.name)
                }));
              }}
            />
            {selectedEvent?.description ? (
              <div className="scheduled-tasks-hint">{selectedEvent.description}</div>
            ) : null}
          </Form.Item>
          <Form.Item label="名称">
            <Input
              value={editor.name}
              placeholder="留空则用事件名"
              onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
            />
          </Form.Item>
          {selectedEvent?.kind === 'custom' ? (
            <>
              <Form.Item label="命令">
                <Input.TextArea
                  rows={3}
                  value={editor.command}
                  placeholder="以服务进程身份执行，例如：echo hello"
                  onChange={(event) => setEditor((prev) => ({ ...prev, command: event.target.value }))}
                />
              </Form.Item>
              <Form.Item label="工作目录（可选）">
                <Input
                  value={editor.cwd}
                  onChange={(event) => setEditor((prev) => ({ ...prev, cwd: event.target.value }))}
                />
              </Form.Item>
            </>
          ) : null}
          <Form.Item label="周期">
            <Space size={8} wrap>
              <Select
                style={{ width: 120 }}
                value={editor.scheduleKind}
                onChange={(value) => setEditor((prev) => ({ ...prev, scheduleKind: value }))}
                options={[
                  { value: 'daily', label: '每天' },
                  { value: 'weekly', label: '每周' },
                  { value: 'interval', label: '按间隔' }
                ]}
              />
              {editor.scheduleKind === 'weekly' ? (
                <Select
                  style={{ width: 110 }}
                  value={editor.weekday}
                  onChange={(value) => setEditor((prev) => ({ ...prev, weekday: Number(value) }))}
                  options={WEEKDAYS.map((label, index) => ({ value: index, label }))}
                />
              ) : null}
              {editor.scheduleKind === 'interval' ? (
                <>
                  <Input
                    type="number"
                    min={0}
                    max={24}
                    style={{ width: 110 }}
                    value={editor.hours}
                    addonAfter="小时"
                    onChange={(event) => setEditor((prev) => ({ ...prev, hours: Number(event.target.value) }))}
                  />
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    style={{ width: 110 }}
                    value={editor.minutes}
                    addonAfter="分钟"
                    onChange={(event) => setEditor((prev) => ({ ...prev, minutes: Number(event.target.value) }))}
                  />
                </>
              ) : (
                <TimePicker
                  format="HH:mm"
                  minuteStep={5}
                  value={dayjs(editor.at, 'HH:mm')}
                  onChange={(value) => setEditor((prev) => ({
                    ...prev,
                    at: value ? value.format('HH:mm') : prev.at
                  }))}
                />
              )}
            </Space>
          </Form.Item>
          <Form.Item label="启用">
            <Switch
              checked={editor.enabled}
              onChange={(checked) => setEditor((prev) => ({ ...prev, enabled: checked }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
