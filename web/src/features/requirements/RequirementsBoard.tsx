import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppstoreOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined
} from '@ant-design/icons';
import {
  Badge, Button, Card, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, message
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { accountsAPI, modelsAPI, sessionsAPI, sshHostsAPI, workspaceConnectorsAPI } from '@/services/api';
import type { AggregatedProject } from '@/types';
import type { SshWorkspace } from '@/features/ssh-hosts/ssh-hosts-model';
import type { WorkspaceConnector } from '@/features/workspace-connectors/workspace-connectors-model';
import { chatRuntimeProviders } from '@/features/chat-runtime/runtime-provider-registry';
import {
  requirementsAPI,
  type Requirement,
  type RequirementEvent,
  type RequirementMode,
  type RequirementSnapshot,
  type RequirementStatus,
  type RequirementStep,
  type ServerProfileView,
  type WorkWorkspaceOption
} from './requirements-api';
import styles from './requirements.module.css';

type ViewMode = 'kanban' | 'list';

const STATUS_LABEL: Record<RequirementStatus, string> = {
  idea: '想法', ready: '待排期', queued: '已领取', running: '执行中', waiting: '等待输入',
  review: '待验收', done: '已完成', blocked: '受阻', archived: '归档'
};
const STATUS_TONE: Record<RequirementStatus, string> = {
  idea: 'default', ready: 'blue', queued: 'gold', running: 'processing', waiting: 'orange',
  review: 'purple', done: 'success', blocked: 'error', archived: 'default'
};
const MODE_LABEL: Record<RequirementMode, string> = { plan: 'plan', goal: 'goal', loop: 'loop' };
const PRIORITY_LABEL = ['高', '普通', '低'];
const EXECUTION_LABEL: Record<string, string> = { native: '原生账号', relay: 'Relay 固定账号', gateway: '网关池化' };

function executionLabel(value: string): string {
  return EXECUTION_LABEL[value] || (value ? value : '自动选号');
}

function effortFromModel(model: string): string {
  const match = /-(low|medium|high|xhigh)$/.exec(String(model || '').toLowerCase());
  return match ? match[1] : '';
}
const COLUMNS: Array<{ key: string; title: string; statuses: RequirementStatus[] }> = [
  { key: 'idea', title: '想法池', statuses: ['idea'] },
  { key: 'ready', title: '待排期', statuses: ['ready'] },
  { key: 'running', title: '执行中', statuses: ['queued', 'running', 'waiting'] },
  { key: 'review', title: '待验收', statuses: ['review'] },
  { key: 'closed', title: '已完成 / 受阻', statuses: ['done', 'blocked', 'archived'] }
];

function sortRequirements(items: Requirement[]): Requirement[] {
  return [...items].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.position !== right.position) return left.position - right.position;
    return left.createdAt - right.createdAt;
  });
}
function formatTime(value: number): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function pathLabel(path: string): string {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || path || '未绑定';
}
function statusTag(status: RequirementStatus) {
  return <Tag color={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>;
}
function modeTag(mode: RequirementMode) {
  return <Tag color={mode === 'loop' ? 'magenta' : mode === 'goal' ? 'cyan' : 'geekblue'}>{MODE_LABEL[mode]}</Tag>;
}
function progressOf(requirement: Requirement): number {
  if (requirement.status === 'done') return 100;
  return Math.max(0, Math.min(100, requirement.progress || 0));
}
function stepsDone(requirement: Requirement): number {
  return (requirement.steps || []).filter((step) => step.status === 'done').length;
}

interface RequirementFormValues {
  title: string; description?: string; status?: RequirementStatus; priority?: number;
  workspacePath?: string; mode?: RequirementMode; parallel?: boolean; steps?: Array<{ text?: string }>;
}

export default function RequirementsBoard() {
  const [snapshot, setSnapshot] = useState<RequirementSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [view, setView] = useState<ViewMode>('kanban');
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('all');
  const [detail, setDetail] = useState<Requirement | null>(null);
  const [events, setEvents] = useState<RequirementEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string>('');
  const [projects, setProjects] = useState<AggregatedProject[]>([]);
  const [sshWorkspaces, setSshWorkspaces] = useState<SshWorkspace[]>([]);
  const [connectorWorkspaces, setConnectorWorkspaces] = useState<WorkspaceConnector[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [schedulerProviders, setSchedulerProviders] = useState<string[]>([]);
  const [schedulerModels, setSchedulerModels] = useState<Record<string, string[]>>({});
  const [schedulerLabels, setSchedulerLabels] = useState<Record<string, Record<string, string>>>({});
  const [schedulerAccounts, setSchedulerAccounts] = useState<Array<{ provider: string; accountRef: string; label: string; status: string }>>([]);
  const [schedulerOptionsLoading, setSchedulerOptionsLoading] = useState(false);
  const [schedulerOptionsError, setSchedulerOptionsError] = useState('');
  const [serverProfiles, setServerProfiles] = useState<ServerProfileView[]>([]);
  const [form] = Form.useForm<RequirementFormValues>();
  const [importForm] = Form.useForm<{ format: string; workspacePath?: string; content: string }>();
  const [schedulerForm] = Form.useForm<{ enabled: boolean; serverProfileId?: string; serverLabel?: string; provider: string; model: string; accountRef?: string; reasoningEffort?: string; maxParallel?: number }>();
  const detailRef = useRef<string>('');
  const schedulerProvider = Form.useWatch('provider', schedulerForm);
  const schedulerModel = Form.useWatch('model', schedulerForm);
  const schedulerAccountRef = Form.useWatch('accountRef', schedulerForm);
  const schedulerServerProfileId = Form.useWatch('serverProfileId', schedulerForm) || '';
  const activeServerProfileId = schedulerOpen ? schedulerServerProfileId : (snapshot?.settings?.serverProfileId || '');

  const applySnapshot = useCallback((next: RequirementSnapshot) => { setSnapshot(next); setError(''); }, []);
  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try { applySnapshot(await requirementsAPI.load()); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : '需求数据加载失败'); }
    finally { setLoading(false); }
  }, [applySnapshot]);
  const loadWorkWorkspaces = useCallback(async (serverProfileId = '') => {
    setWorkspacesLoading(true);
    try {
      const [projectList, sshList, connectorList] = await Promise.all([
        sessionsAPI.getAllProjects({ serverProfileId }),
        sshHostsAPI.listWorkspaces({ serverProfileId }),
        workspaceConnectorsAPI.list({ serverProfileId }).catch(() => ({ ok: false, count: 0, workspaces: [] as WorkspaceConnector[] }))
      ]);
      setProjects(Array.isArray(projectList) ? projectList : []);
      setSshWorkspaces(Array.isArray(sshList) ? sshList as SshWorkspace[] : []);
      setConnectorWorkspaces(Array.isArray(connectorList?.workspaces) ? connectorList.workspaces : []);
    } catch { setProjects([]); setSshWorkspaces([]); setConnectorWorkspaces([]); }
    finally { setWorkspacesLoading(false); }
  }, []);

  const loadSchedulerOptions = useCallback(async (serverProfileId = '') => {
    setSchedulerOptionsLoading(true);
    setSchedulerOptionsError('');
    try {
      const [accountResult, catalog] = await Promise.all([
        accountsAPI.list({ serverProfileId }),
        modelsAPI.listCatalog({ serverProfileId })
      ]);
      const supported = new Set(chatRuntimeProviders.providers().map(String));
      const providers = new Set<string>();
      const accounts: Array<{ provider: string; accountRef: string; label: string; status: string }> = [];
      for (const account of accountResult.accounts || []) {
        const provider = String(account.provider || '');
        const accountRef = String(account.accountRef || '');
        if (!provider || !accountRef || !supported.has(provider)) continue;
        if ((account as { gateway?: boolean }).gateway) continue;
        providers.add(provider);
        const record = account as { label?: string; displayName?: string; email?: string; status?: string };
        accounts.push({
          provider,
          accountRef,
          label: record.label || record.displayName || record.email || accountRef,
          status: String(record.status || '')
        });
      }
      setSchedulerProviders(Array.from(providers).sort());
      setSchedulerModels(catalog.models || {});
      setSchedulerLabels(catalog.labels || {});
      setSchedulerAccounts(accounts.sort((left, right) => left.label.localeCompare(right.label)));
      return { providers: Array.from(providers).sort(), models: catalog.models || {}, labels: catalog.labels || {}, accounts };
    } catch (optionError) {
      setSchedulerOptionsError(optionError instanceof Error ? optionError.message : '无法读取可用 Provider / 模型目录');
      setSchedulerProviders([]);
      setSchedulerModels({});
      setSchedulerLabels({});
      setSchedulerAccounts([]);
      return null;
    } finally {
      setSchedulerOptionsLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void requirementsAPI.listServers().then(setServerProfiles).catch(() => setServerProfiles([]));
  }, []);
  useEffect(() => { void loadWorkWorkspaces(activeServerProfileId); }, [activeServerProfileId, loadWorkWorkspaces]);
  useEffect(() => {
    const source = requirementsAPI.watch({
      onSnapshot: (next) => { applySnapshot(next); setLive(true); },
      onConnected: () => setLive(true),
      onError: () => setLive(false)
    });
    return () => source.close();
  }, [applySnapshot]);
  useEffect(() => {
    const onFocus = () => {
      void refresh({ silent: true }); void loadWorkWorkspaces(activeServerProfileId);
      if (detailRef.current) void loadEvents(detailRef.current);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [loadWorkWorkspaces, refresh]);
  useEffect(() => {
    if (!snapshot || !detail) return;
    const found = snapshot.requirements.find((item) => item.id === detail.id);
    if (found) setDetail(found);
  }, [snapshot, detail?.id]);

  const requirements = snapshot?.requirements || [];
  const scheduler = snapshot?.scheduler;

  const workWorkspaces = useMemo<WorkWorkspaceOption[]>(() => {
    const map = new Map<string, WorkWorkspaceOption>();
    for (const project of projects) {
      if (!project.path) continue;
      map.set(project.path, { path: project.path, label: project.name || pathLabel(project.path), kind: 'local', detail: project.path });
    }
    for (const workspace of sshWorkspaces) {
      if (!workspace.projectPath) continue;
      map.set(workspace.projectPath, { path: workspace.projectPath, label: `远程 · ${workspace.label || pathLabel(workspace.projectPath)}`, kind: 'ssh', detail: workspace.remoteRoot || workspace.projectPath });
    }
    for (const workspace of connectorWorkspaces) {
      if (!workspace.shadowPath) continue;
      const state = workspace.state === 'online' ? '在线' : workspace.state === 'revoked' ? '已撤销' : '离线';
      map.set(workspace.shadowPath, {
        path: workspace.shadowPath,
        label: `本地工作区 · ${workspace.label || workspace.id}`,
        kind: 'connector',
        detail: [workspace.rootLabel, state].filter(Boolean).join(' · ')
      });
    }
    for (const requirement of requirements) {
      if (!requirement.workspacePath || map.has(requirement.workspacePath)) continue;
      const kind = requirement.workspaceKind === 'ssh' ? 'ssh' : requirement.workspaceKind === 'connector' ? 'connector' : 'local';
      map.set(requirement.workspacePath, { path: requirement.workspacePath, label: requirement.workspaceLabel || pathLabel(requirement.workspacePath), kind, detail: requirement.workspacePath });
    }
    return Array.from(map.values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [projects, requirements, sshWorkspaces, connectorWorkspaces]);

  const workspaceOption = useCallback((path: string) => workWorkspaces.find((workspace) => workspace.path === path), [workWorkspaces]);
  const workspaceDetail = useCallback((requirement: Requirement) => (
    workspaceOption(requirement.workspacePath)?.detail || requirement.workspacePath
  ), [workspaceOption]);
  const workspaceName = useCallback((requirement: Requirement) => {
    const option = workspaceOption(requirement.workspacePath);
    if (option) return option.label;
    if (requirement.workspaceLabel) return requirement.workspaceLabel;
    return requirement.workspacePath ? pathLabel(requirement.workspacePath) : '未绑定 Work 工作区';
  }, [workspaceOption]);
  const workspaceOptions = useMemo(() => {
    const options = [{ label: '全部工作区', value: 'all' }];
    for (const workspace of workWorkspaces) {
      const suffix = workspace.kind === 'ssh' ? ' · SSH' : workspace.kind === 'connector' ? ' · 本地工作区' : '';
      options.push({ label: `${workspace.label}${suffix}`, value: workspace.path });
    }
    return options;
  }, [workWorkspaces]);
  const requirementWorkspaceOptions = useMemo(() => workWorkspaces.map((workspace) => {
    const suffix = workspace.kind === 'ssh' ? ' · 远程' : workspace.kind === 'connector' ? ' · 本地工作区' : '';
    return {
      label: `${workspace.label}${suffix} · ${workspace.detail || workspace.path}`,
      value: workspace.path
    };
  }), [workWorkspaces]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sortRequirements(requirements).filter((item) => {
      if (workspaceFilter !== 'all' && item.workspacePath !== workspaceFilter) return false;
      if (!needle) return true;
      return `${item.title} ${item.description} ${workspaceName(item)} ${item.workspacePath}`.toLowerCase().includes(needle);
    });
  }, [requirements, query, workspaceFilter, workspaceName]);
  const counts = useMemo(() => {
    const result = { idea: 0, ready: 0, running: 0, review: 0, done: 0 };
    for (const item of requirements) {
      if (item.status === 'idea') result.idea += 1;
      else if (item.status === 'ready') result.ready += 1;
      else if (item.status === 'queued' || item.status === 'running' || item.status === 'waiting') result.running += 1;
      else if (item.status === 'review') result.review += 1;
      else if (item.status === 'done') result.done += 1;
    }
    return result;
  }, [requirements]);

  const schedulerProviderOptions = useMemo(() => {
    const providers = new Set(schedulerProviders);
    const current = snapshot?.settings?.provider;
    if (current) providers.add(current);
    return Array.from(providers).sort().map((provider) => ({ label: provider, value: provider }));
  }, [schedulerProviders, snapshot?.settings?.provider]);

  const schedulerServerOptions = useMemo(() => {
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const remoteProfiles = serverProfiles.filter((profile) => {
      try { return new URL(profile.endpoint).origin !== currentOrigin; } catch { return true; }
    });
    return [
      { label: '本地（当前 Server）', value: '' },
      ...remoteProfiles.map((profile) => ({
        label: `${profile.label} · ${profile.endpoint}`,
        value: profile.id
      }))
    ];
  }, [serverProfiles]);

  const schedulerModelOptions = useMemo(() => {
    const provider = String(schedulerProvider || '');
    const models = new Set(schedulerModels[provider] || []);
    const current = snapshot?.settings?.model;
    if (provider && provider === snapshot?.settings?.provider && current) models.add(current);
    return Array.from(models).sort().map((model) => ({
      label: schedulerLabels[provider]?.[model] || model,
      value: model
    }));
  }, [schedulerLabels, schedulerModels, schedulerProvider, snapshot?.settings?.model, snapshot?.settings?.provider]);

  const derivedSchedulerEffort = effortFromModel(String(schedulerModel || ''));
  const schedulerIndependentEffort = schedulerProvider === 'codex';
  const schedulerEffortDisabled = Boolean(derivedSchedulerEffort) || schedulerProvider === 'agy' || !schedulerIndependentEffort;
  const schedulerEffortOptions = useMemo(() => {
    if (derivedSchedulerEffort) return [{ label: `${derivedSchedulerEffort}（由模型决定）`, value: derivedSchedulerEffort }];
    if (!schedulerIndependentEffort) return [{ label: schedulerProvider === 'agy' ? '默认（由模型变体决定）' : '默认（由 Provider 决定）', value: '' }];
    return ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ label: effort, value: effort }));
  }, [derivedSchedulerEffort, schedulerIndependentEffort, schedulerProvider]);

  const schedulerAccountOptions = useMemo(() => {
    const options: Array<{ label: string; value: string }> = [{ label: '自动选号（推荐）', value: '' }];
    let hasCurrent = false;
    for (const account of schedulerAccounts) {
      if (account.provider !== schedulerProvider) continue;
      if (account.accountRef === schedulerAccountRef) hasCurrent = true;
      options.push({
        label: `${account.label}${account.status ? ` · ${account.status}` : ''}`,
        value: account.accountRef
      });
    }
    if (schedulerAccountRef && !hasCurrent) {
      options.push({ label: `${schedulerAccountRef}（当前配置）`, value: schedulerAccountRef });
    }
    return options;
  }, [schedulerAccountRef, schedulerAccounts, schedulerProvider]);

  const schedulerProviderAvailable = schedulerOptionsLoading || !schedulerProvider
    ? true
    : schedulerProviders.includes(schedulerProvider);

  function effectiveSchedulerEffort(provider: string | undefined, model: string, fallback?: string): string {
    const derived = effortFromModel(model);
    if (derived) return derived;
    if (provider !== 'codex') return '';
    return fallback || 'xhigh';
  }

  function handleSchedulerProviderChange(provider: string): void {
    const firstModel = (schedulerModels[provider] || [])[0] || '';
    schedulerForm.setFieldsValue({
      provider,
      model: firstModel,
      reasoningEffort: effectiveSchedulerEffort(provider, firstModel, ''),
      accountRef: ''
    });
  }

  function handleSchedulerModelChange(model: string): void {
    schedulerForm.setFieldsValue({
      model,
      reasoningEffort: effectiveSchedulerEffort(schedulerProvider, model, schedulerForm.getFieldValue('reasoningEffort'))
    });
  }

  async function loadEvents(id: string) {
    detailRef.current = id; setEventsLoading(true);
    try { setEvents(await requirementsAPI.events(id)); } catch { setEvents([]); } finally { setEventsLoading(false); }
  }
  function openDetail(requirement: Requirement) { setDetail(requirement); setEvents([]); void loadEvents(requirement.id); }
  function closeDetail() { setDetail(null); setEvents([]); detailRef.current = ''; }
  function openCreate() {
    setEditing(null); form.resetFields();
    form.setFieldsValue({ status: 'idea', priority: 1, mode: 'plan', parallel: false, steps: [] });
    setEditorOpen(true);
  }
  function openEdit(requirement: Requirement) {
    setEditing(requirement);
    form.setFieldsValue({
      title: requirement.title, description: requirement.description, status: requirement.status,
      priority: requirement.priority, workspacePath: requirement.workspacePath || undefined,
      mode: requirement.mode, parallel: requirement.parallel,
      steps: requirement.steps?.map((step) => ({ text: step.text })) || []
    });
    setEditorOpen(true);
  }
  function selectedWorkWorkspace(path?: string): WorkWorkspaceOption | undefined {
    if (!path) return undefined;
    return workspaceOption(path) || { path, label: pathLabel(path), kind: 'local', detail: path };
  }

  async function submitEditor() {
    try {
      const values = await form.validateFields();
      if ((values.status || (editing?.status ?? 'idea')) === 'ready' && !values.workspacePath) {
        message.warning('进入排期前必须在 Work 中选择工作区'); return;
      }
      const workspace = selectedWorkWorkspace(values.workspacePath);
      const steps: RequirementStep[] = (values.steps || []).map((step) => String(step?.text || '').trim()).filter(Boolean).map((text) => ({ text, status: 'pending' as const }));
      if (editing) {
        const updated = await requirementsAPI.update(editing.id, {
          title: values.title, description: values.description || '', priority: values.priority ?? 1,
          workspacePath: workspace?.path || '', workspaceLabel: workspace?.label || '', workspaceKind: workspace?.kind || '',
          mode: values.mode || 'plan', parallel: Boolean(values.parallel), steps
        });
        setDetail(updated); message.success('需求已更新');
      } else {
        await requirementsAPI.create({
          title: values.title, description: values.description || '', status: values.status || 'idea', priority: values.priority ?? 1,
          workspacePath: workspace?.path || '', workspaceLabel: workspace?.label || '', workspaceKind: workspace?.kind || '',
          mode: values.mode || 'plan', parallel: Boolean(values.parallel), steps
        });
        message.success('需求已创建');
      }
      setEditorOpen(false); await refresh({ silent: true });
    } catch (submitError) { if (submitError instanceof Error) message.error(submitError.message); }
  }

  async function mutate(requirement: Requirement, action: 'confirm' | 'refine' | 'dispatch' | 'cancel' | 'done' | 'delete') {
    if (action === 'delete') {
      setBusyId(requirement.id);
      try {
        await requirementsAPI.remove(requirement.id);
        if (detail?.id === requirement.id) closeDetail();
        message.success('需求已删除'); await refresh({ silent: true });
      } catch (deleteError) { message.error(deleteError instanceof Error ? deleteError.message : '删除失败'); }
      finally { setBusyId(''); }
      return;
    }
    setBusyId(requirement.id);
    try {
      const workspace = selectedWorkWorkspace(requirement.workspacePath);
      if ((action === 'confirm' || action === 'refine' || action === 'dispatch') && !workspace) {
        message.warning('请先在编辑里选择 /ui/chat（Work）中的工作区'); return;
      }
      if (action === 'confirm') { await requirementsAPI.update(requirement.id, { status: 'ready' }); message.success('已确认进入排期'); }
      else if (action === 'refine') {
        message.loading({ content: 'AI 正在拆解需求…', key: 'refine', duration: 0 });
        await requirementsAPI.refine(requirement.id, workspace);
        message.success({ content: '需求已拆解', key: 'refine' });
      } else if (action === 'dispatch') { await requirementsAPI.dispatch(requirement.id, workspace); message.success('已派发给执行会话'); }
      else if (action === 'cancel') { await requirementsAPI.cancel(requirement.id); message.success('已取消执行'); }
      else if (action === 'done') { await requirementsAPI.update(requirement.id, { status: 'done' }); message.success('需求已验收'); }
      await refresh({ silent: true });
      if (detail?.id === requirement.id) await loadEvents(requirement.id);
    } catch (actionError) {
      if (action === 'refine') message.destroy('refine');
      message.error(actionError instanceof Error ? actionError.message : '操作失败');
    } finally { setBusyId(''); }
  }

  async function toggleStep(requirement: Requirement, index: number) {
    const steps = requirement.steps.map((step, stepIndex) => stepIndex === index
      ? { ...step, status: step.status === 'done' ? 'pending' as const : 'done' as const } : step);
    try { await requirementsAPI.update(requirement.id, { steps }); await refresh({ silent: true }); }
    catch (stepError) { message.error(stepError instanceof Error ? stepError.message : '步骤更新失败'); }
  }
  async function runScheduler() {
    try { await requirementsAPI.runScheduler(); message.success('调度器已执行一轮'); await refresh({ silent: true }); }
    catch (runError) { message.error(runError instanceof Error ? runError.message : '调度失败'); }
  }
  async function toggleScheduler(enabled: boolean) {
    try { await requirementsAPI.updateScheduler({ ...(snapshot?.settings || {}), enabled }); message.success(enabled ? '调度器已启用' : '调度器已暂停'); await refresh({ silent: true }); }
    catch (toggleError) { message.error(toggleError instanceof Error ? toggleError.message : '调度器设置失败'); }
  }
  function handleSchedulerServerChange(serverProfileId?: string) {
    const selected = serverProfiles.find((profile) => profile.id === serverProfileId);
    schedulerForm.setFieldsValue({
      serverLabel: selected?.label || '',
      provider: undefined,
      model: undefined,
      accountRef: '',
      reasoningEffort: ''
    });
    void loadSchedulerOptions(serverProfileId || '');
    void loadWorkWorkspaces(serverProfileId || '');
  }
  function openSchedulerSettings() {
    const settings = snapshot?.settings;
    const provider = settings?.provider || '';
    const model = settings?.model || '';
    schedulerForm.setFieldsValue({
      enabled: settings?.enabled ?? true,
      serverProfileId: settings?.serverProfileId || '',
      serverLabel: settings?.serverLabel || '',
      provider: provider || undefined,
      model: model || undefined,
      accountRef: settings?.accountRef || '',
      reasoningEffort: effectiveSchedulerEffort(provider, model, settings?.reasoningEffort || ''),
      maxParallel: settings?.maxParallel || 2
    });
    setSchedulerOpen(true);
    void loadSchedulerOptions(settings?.serverProfileId || '').then((options) => {
      if (!options) return;
      const currentProvider = String(schedulerForm.getFieldValue('provider') || '');
      const currentModel = String(schedulerForm.getFieldValue('model') || '');
      if (currentProvider) {
        if (!currentModel) {
          const nextModel = (options.models[currentProvider] || [])[0] || '';
          schedulerForm.setFieldsValue({
            model: nextModel || undefined,
            reasoningEffort: effectiveSchedulerEffort(currentProvider, nextModel, '')
          });
        }
        return;
      }
      const nextProvider = options.providers[0] || '';
      const nextModel = (options.models[nextProvider] || [])[0] || '';
      schedulerForm.setFieldsValue({
        provider: nextProvider || undefined,
        model: nextModel || undefined,
        reasoningEffort: effectiveSchedulerEffort(nextProvider, nextModel, '')
      });
    });
  }
  async function saveSchedulerSettings() {
    try {
      const values = await schedulerForm.validateFields();
      const selected = serverProfiles.find((profile) => profile.id === values.serverProfileId);
      await requirementsAPI.updateScheduler({ ...values, serverLabel: selected?.label || '' });
      setSchedulerOpen(false);
      message.success('调度器配置已保存');
      await refresh({ silent: true });
      void loadWorkWorkspaces(values.serverProfileId || '');
    } catch (saveError) { if (saveError instanceof Error) message.error(saveError.message); }
  }
  async function submitImport() {
    try {
      const values = await importForm.validateFields();
      const workspace = selectedWorkWorkspace(values.workspacePath);
      const result = await requirementsAPI.import({ format: values.format, content: values.content, workspacePath: workspace?.path, workspaceLabel: workspace?.label, workspaceKind: workspace?.kind });
      message.success(`已导入 ${result.count} 条需求`);
      setImportOpen(false); importForm.resetFields(); await refresh({ silent: true });
    } catch (submitError) { if (submitError instanceof Error) message.error(submitError.message); }
  }
  async function moveRequirement(requirement: Requirement, direction: -1 | 1) {
    const ordered = sortRequirements(requirements);
    const index = ordered.findIndex((item) => item.id === requirement.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    try { applySnapshot(await requirementsAPI.reorder(next.map((item) => item.id))); }
    catch (moveError) { message.error(moveError instanceof Error ? moveError.message : '排序失败'); }
  }

  const columns: ColumnsType<Requirement> = [
    { title: '需求', dataIndex: 'title', key: 'title', render: (_value, record) => (
      <button type="button" className={styles.titleLink} onClick={() => openDetail(record)}>
        <span>{record.title}</span><span className={styles.titleMeta}>{workspaceName(record)} · {record.parallel ? '可并行' : '顺序'}</span>
      </button>
    ) },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (status: RequirementStatus) => statusTag(status) },
    { title: '优先级', dataIndex: 'priority', key: 'priority', width: 90, render: (priority: number) => <Tag color={priority === 0 ? 'red' : priority === 1 ? 'default' : 'blue'}>{PRIORITY_LABEL[priority] || '普通'}</Tag> },
    { title: '模式', dataIndex: 'mode', key: 'mode', width: 90, render: (mode: RequirementMode) => modeTag(mode) },
    { title: '进度', dataIndex: 'progress', key: 'progress', width: 180, render: (_value, record) => (
      <div className={styles.progressCell}><Progress percent={progressOf(record)} size="small" showInfo={false} status={record.status === 'blocked' ? 'exception' : undefined} /><span>{record.progressNote || `${progressOf(record)}%`}</span></div>
    ) },
    { title: '步骤', key: 'steps', width: 90, render: (_value, record) => `${stepsDone(record)}/${record.steps?.length || 0}` },
    { title: '操作', key: 'actions', width: 190, render: (_value, record) => (
      <Space size={4} wrap>
        <Button size="small" icon={<ArrowUpOutlined />} onClick={() => void moveRequirement(record, -1)} />
        <Button size="small" icon={<ArrowDownOutlined />} onClick={() => void moveRequirement(record, 1)} />
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
        <Popconfirm title="删除这张需求？" onConfirm={() => void mutate(record, 'delete')}><Button size="small" danger icon={<DeleteOutlined />} /></Popconfirm>
      </Space>
    ) }
  ];

  function renderCard(requirement: Requirement) {
    const isBusy = busyId === requirement.id;
    const isActive = ['queued', 'running', 'waiting'].includes(requirement.status);
    return (
      <article key={requirement.id} className={styles.card} data-status={requirement.status} onClick={() => openDetail(requirement)} role="button" tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openDetail(requirement); }}>
        <div className={styles.cardHead}>
          <span className={styles.priorityDot} data-priority={requirement.priority} />
          <h3>{requirement.title}</h3>
          <span className={styles.cardStatus}>{statusTag(requirement.status)}</span>
        </div>
        {requirement.description ? <p className={styles.cardDescription}>{requirement.description}</p> : null}
        <div className={styles.cardMeta}>
          <Tag icon={<FolderOpenOutlined />}>{workspaceName(requirement)}</Tag>
          {modeTag(requirement.mode)}
          {requirement.parallel ? <Tag color="green">并行</Tag> : null}
          {requirement.refinedAt ? <Tag color="purple">AI 已优化</Tag> : null}
          {requirement.steps?.length ? <span className={styles.cardSteps}>{stepsDone(requirement)}/{requirement.steps.length} 步</span> : null}
        </div>
        {requirement.assignedAt ? (
          <div className={styles.cardAssignment} title={`harness: ${requirement.assignedHarness || requirement.assignedProvider}`}>
            <span className={styles.assignmentArrow}>→</span>
            <Tag color="purple">{requirement.assignedServerLabel || '本地'}</Tag>
            <Tag color="geekblue">{requirement.assignedProvider || '—'}</Tag>
            <Tag>{requirement.assignedModel || '—'}</Tag>
            <Tag color="cyan">{requirement.assignedEffort || '默认'}</Tag>
            <span className={styles.assignmentExecution}>{executionLabel(requirement.assignedExecution)}</span>
          </div>
        ) : null}
        {(isActive || requirement.status === 'review' || requirement.status === 'done') ? (
          <div className={styles.cardProgress}><Progress percent={progressOf(requirement)} size="small" status={requirement.status === 'blocked' ? 'exception' : undefined} /><span>{requirement.progressNote || '等待执行'}</span></div>
        ) : null}
        <div className={styles.cardActions} onClick={(event) => event.stopPropagation()}>
          <Tooltip title="AI 优化需求（手动触发）"><Button size="small" className={styles.cardOptimize} icon={<RobotOutlined />} loading={isBusy} disabled={!requirement.workspacePath} onClick={() => void mutate(requirement, 'refine')}>优化</Button></Tooltip>
          {requirement.status === 'idea' ? <Tooltip title="确认进入排期"><Button size="small" icon={<CheckCircleOutlined />} loading={isBusy} disabled={!requirement.workspacePath} onClick={() => void mutate(requirement, 'confirm')} /></Tooltip> : null}
          {requirement.status === 'ready' ? <Tooltip title="立即执行"><Button size="small" type="primary" icon={<PlayCircleOutlined />} loading={isBusy} onClick={() => void mutate(requirement, 'dispatch')} /></Tooltip> : null}
          {requirement.status === 'review' ? <Tooltip title="验收完成"><Button size="small" icon={<CheckCircleOutlined />} loading={isBusy} onClick={() => void mutate(requirement, 'done')} /></Tooltip> : null}
          {requirement.status === 'blocked' ? <Tooltip title="重新排期"><Button size="small" icon={<ReloadOutlined />} loading={isBusy} onClick={() => void mutate(requirement, 'confirm')} /></Tooltip> : null}
          {isActive ? <Tooltip title="取消执行"><Button size="small" icon={<PauseCircleOutlined />} loading={isBusy} onClick={() => void mutate(requirement, 'cancel')} /></Tooltip> : null}
          <span className={styles.cardTime}>{new Date(requirement.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
        </div>
      </article>
    );
  }

  return (
    <main className={`${styles.page} aih-panel-enter`}>
      <header className={`${styles.hero} hud-panel hud-panel--sm`}>
        <div className={styles.heroMain}>
          <span className={styles.eyebrow}>SYS // REQUIREMENT OPS</span>
          <h1>需求管理</h1>
          <p>想法池、排期与 AI 执行进度在同一条流水线上。工作区直接复用 AI 会话 → Work 里的项目和远程工作区。</p>
          <div className={styles.metrics}>
            <span><strong>{counts.idea}</strong><em>想法</em></span><span><strong>{counts.ready}</strong><em>待排期</em></span>
            <span><strong>{counts.running}</strong><em>执行中</em></span><span><strong>{counts.review}</strong><em>待验收</em></span>
            <span><strong>{counts.done}</strong><em>已完成</em></span>
          </div>
        </div>
        <div className={styles.heroActions}>
          <div className={styles.schedulerCard}>
            <div className={styles.schedulerHead}><span className={styles.schedulerTitle}><RobotOutlined /> 调度器</span><Switch size="small" checked={Boolean(snapshot?.settings?.enabled)} onChange={(checked) => void toggleScheduler(checked)} /></div>
            <div className={styles.schedulerMeta}><Tag color="purple">{scheduler?.serverLabel || '本地'}</Tag><Tag color="geekblue">{scheduler?.provider || '未配置'} / {scheduler?.model || '未配置'} / {scheduler?.reasoningEffort || '—'}</Tag><span className={styles.liveDot} data-live={live ? 'on' : 'off'}>{live ? '实时同步' : '连接断开'}</span></div>
            <div className={styles.schedulerStats}><span>运行 {scheduler?.running ?? 0}</span><span>并行 {scheduler?.maxParallel ?? 2}</span><span>上次 {scheduler?.lastRun ? new Date(scheduler.lastRun).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</span></div>
            <Space size={4} wrap><Button size="small" icon={<ThunderboltOutlined />} onClick={() => void runScheduler()}>运行调度</Button><Button size="small" icon={<SettingOutlined />} onClick={openSchedulerSettings}>配置</Button></Space>
          </div>
          <div className={styles.primaryActions}>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建需求</Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>导入</Button>
            <Button icon={<FolderOpenOutlined />} href="/ui/chat">打开 Work</Button>
          </div>
        </div>
      </header>

      {error ? <div className={styles.inlineError} role="status"><ExclamationCircleOutlined /> {error}<Button size="small" type="link" onClick={() => void refresh()}>重试</Button></div> : null}
      {scheduler?.lastError ? <div className={styles.inlineNote} role="status"><ClockCircleOutlined /> 调度器：{scheduler.lastError}</div> : null}
      {!workspacesLoading && workWorkspaces.length === 0 ? <div className={styles.inlineNote} role="status"><FolderOpenOutlined /> 还没有 Work 工作区。请先在 AI 会话 → Work 打开一个本地项目或远程工作区，需求才能绑定和执行。</div> : null}

      <section className={styles.toolbar}>
        <Input.Search allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索需求、描述或工作区" className={styles.search} />
        <Select value={workspaceFilter} onChange={setWorkspaceFilter} options={workspaceOptions} className={styles.workspaceFilter} showSearch />
        <Segmented value={view} onChange={(value) => setView(value as ViewMode)} options={[
          { label: '看板', value: 'kanban', icon: <AppstoreOutlined /> }, { label: '列表', value: 'list', icon: <UnorderedListOutlined /> }
        ]} />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void refresh(); void loadWorkWorkspaces(activeServerProfileId); }}>刷新</Button>
      </section>

      {view === 'kanban' ? (
        <section className={styles.board}>
          {COLUMNS.map((column) => {
            const items = filtered.filter((item) => column.statuses.includes(item.status));
            return (
              <div key={column.key} className={styles.column}>
                <div className={styles.columnHead}><span>{column.title}</span><Badge count={items.length} showZero color="var(--color-muted)" /></div>
                <div className={styles.columnBody}>{items.length === 0 ? <div className={styles.columnEmpty}>暂无需求</div> : items.map((item) => renderCard(item))}</div>
              </div>
            );
          })}
        </section>
      ) : (
        <Card className={styles.tableCard} bordered={false}>
          <Table<Requirement> rowKey="id" size="small" columns={columns} dataSource={filtered} pagination={false} scroll={{ x: 980 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需求" /> }} />
        </Card>
      )}

      <Drawer open={Boolean(detail)} onClose={closeDetail} width={620}
        title={detail ? <span className={styles.drawerTitle}>{detail.title} {statusTag(detail.status)}</span> : '需求详情'}
        extra={detail ? (
          <Space size={4} wrap>
            <Button size="small" icon={<RobotOutlined />} loading={busyId === detail.id} onClick={() => void mutate(detail, 'refine')}>AI 优化</Button>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(detail)}>编辑</Button>
            {detail.status === 'idea' ? <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => void mutate(detail, 'confirm')}>确认排期</Button> : null}
            {detail.status === 'ready' ? <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void mutate(detail, 'dispatch')}>立即执行</Button> : null}
            {detail.status === 'review' ? <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => void mutate(detail, 'done')}>验收完成</Button> : null}
            {detail.status === 'blocked' ? <Button size="small" icon={<ReloadOutlined />} onClick={() => void mutate(detail, 'confirm')}>重新排期</Button> : null}
            {['queued', 'running', 'waiting'].includes(detail.status) ? <Button size="small" icon={<PauseCircleOutlined />} onClick={() => void mutate(detail, 'cancel')}>取消</Button> : null}
          </Space>
        ) : null}>
        {detail ? (
          <div className={styles.detail}>
            <div className={styles.detailTags}>
              {statusTag(detail.status)}{modeTag(detail.mode)}<Tag icon={<FolderOpenOutlined />}>{workspaceName(detail)}</Tag>
              <Tag color={detail.parallel ? 'green' : 'default'}>{detail.parallel ? '可并行' : '顺序执行'}</Tag>
              {detail.refinedAt ? <Tag color="purple">AI 已优化 · {(detail.steps || []).length} 步</Tag> : null}
              {detail.source !== 'manual' ? <Tag color="gold">{detail.source}</Tag> : null}
            </div>
            {detail.workspacePath ? <code className={styles.pathCode}>{detail.workspaceKind === 'connector' ? `本地工作区 · ${workspaceDetail(detail)}（执行时镜像，完成后写回）` : detail.workspacePath}</code> : <div className={styles.inlineNote}><FolderOpenOutlined /> 还没有绑定 Work 工作区。请编辑并选择 /ui/chat（Work）里的项目或远程工作区。</div>}
            <div className={styles.detailProgress}><Progress percent={progressOf(detail)} status={detail.status === 'blocked' ? 'exception' : undefined} /><span>{detail.progressNote || '等待调度'}</span></div>
            {detail.lastError ? <div className={styles.inlineError}><ExclamationCircleOutlined /> {detail.lastError}</div> : null}
            <section className={styles.detailSection}>
              <h3>调度安排</h3>
              {detail.assignedAt ? (
                <div className={styles.assignmentGrid}>
                  <div><span>执行 Server</span><strong>{detail.assignedServerLabel || '本地（当前 Server）'}</strong></div>
                  <div><span>Provider</span><strong>{detail.assignedProvider || '—'}</strong></div>
                  <div><span>Harness</span><strong>{detail.assignedHarness || detail.assignedProvider || '—'}</strong></div>
                  <div><span>执行方式</span><strong>{executionLabel(detail.assignedExecution)}</strong></div>
                  <div><span>账号</span><strong>{detail.assignedAccountRef || '自动选号'}</strong></div>
                  <div><span>模型</span><strong>{detail.assignedModel || '—'}</strong></div>
                  <div><span>思考强度</span><strong>{detail.assignedEffort || '默认（由模型决定）'}</strong></div>
                  <div><span>分配时间</span><strong>{formatTime(detail.assignedAt)}</strong></div>
                  <div><span>会话</span><strong>{detail.sessionId || '—'}</strong></div>
                </div>
              ) : <div className={styles.muted}>尚未调度。确认排期并执行后，这里会显示实际 provider/harness、原生账号或 Relay、模型与思考强度。</div>}
            </section>
            <section className={styles.detailSection}><h3>描述</h3><pre className={styles.description}>{detail.description || '暂无描述'}</pre></section>
            <section className={styles.detailSection}>
              <div className={styles.sectionHead}><h3>执行步骤</h3><Button size="small" icon={<RobotOutlined />} loading={busyId === detail.id} onClick={() => void mutate(detail, 'refine')}>AI 优化</Button></div>
              <div className={styles.muted}>手动触发；必须已绑定 Work 工作区。AI 会把模糊描述整理成 1..n 步和验收标准。</div>
              {detail.steps?.length ? (
                <ul className={styles.steps}>{detail.steps.map((step, index) => (
                  <li key={`${detail.id}-${index}`} data-done={step.status === 'done'}>
                    <button type="button" onClick={() => void toggleStep(detail, index)} aria-label={step.status === 'done' ? '标记未完成' : '标记完成'}><CheckCircleOutlined /></button>
                    <span>{step.text}</span>
                  </li>
                ))}</ul>
              ) : <div className={styles.muted}>还没有拆解步骤。绑定 Work 工作区后可以让 AI 生成 1..n 步。</div>}
            </section>
            {detail.sessionId ? (
              <section className={styles.detailSection}>
                <h3>执行会话</h3>
                <div className={styles.sessionRow}>
                  <Tag color="geekblue">{detail.sessionId}</Tag>
                  {detail.workspaceKind === 'connector'
                    ? <span className={styles.muted}>本地 Connector 工作区；执行和同步都在 Server 端完成</span>
                    : <Button size="small" icon={<LinkOutlined />} href={`/ui/chat?sessionId=${encodeURIComponent(detail.sessionId)}&projectPath=${encodeURIComponent(detail.workspacePath)}`}>在 Work 打开</Button>}
                </div>
                {detail.peerMessageId ? <div className={styles.muted}>peer 任务：{detail.peerMessageId}</div> : null}
              </section>
            ) : null}
            <section className={styles.detailSection}>
              <h3>时间线</h3>
              {eventsLoading ? <div className={styles.muted}>加载中…</div> : events.length ? (
                <ul className={styles.timeline}>{events.map((event) => (
                  <li key={event.id}><span className={styles.timelineDot} /><div><strong>{event.message}</strong><span>{formatTime(event.at)} · {event.kind}</span></div></li>
                ))}</ul>
              ) : <div className={styles.muted}>暂无记录</div>}
            </section>
          </div>
        ) : null}
      </Drawer>

      <Modal open={editorOpen} title={editing ? '编辑需求' : '新建需求'} onCancel={() => setEditorOpen(false)} onOk={() => void submitEditor()} okText={editing ? '保存' : '创建'} width={640} destroyOnClose>
        <Form form={form} layout="vertical" className={styles.form}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入需求标题' }]}><Input placeholder="例如：把需求管理接入项目办公室" /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={5} placeholder="可以很短、很模糊；确认后可用 AI 拆解成 1..n 步。" /></Form.Item>
          <div className={styles.formRow}>
            <Form.Item name="status" label="状态" initialValue="idea"><Select options={[{ label: '想法（未确认）', value: 'idea' }, { label: '待排期（已确认）', value: 'ready' }]} disabled={Boolean(editing)} /></Form.Item>
            <Form.Item name="priority" label="优先级" initialValue={1}><Select options={[{ label: '高', value: 0 }, { label: '普通', value: 1 }, { label: '低', value: 2 }]} /></Form.Item>
          </div>
          <Form.Item name="workspacePath" label="Work 工作区" extra="与 AI 会话 → Work 的工作区同一概念；远程工作区会自动使用影子路径，本地 Connector 工作区会在执行时镜像并在完成后写回。">
            <Select allowClear showSearch options={requirementWorkspaceOptions} placeholder={requirementWorkspaceOptions.length ? '选择 Work 中的项目或远程工作区' : '还没有 Work 工作区，请先去 AI 会话 → Work 打开项目'} />
          </Form.Item>
          <div className={styles.formRow}>
            <Form.Item name="mode" label="执行模式" initialValue="plan"><Select options={[{ label: 'plan · 先计划', value: 'plan' }, { label: 'goal · 目标驱动', value: 'goal' }, { label: 'loop · 自动验收循环', value: 'loop' }]} /></Form.Item>
            <Form.Item name="parallel" label="允许并行" valuePropName="checked" initialValue={false}><Switch checkedChildren="并行" unCheckedChildren="顺序" /></Form.Item>
          </div>
          <Form.Item label="步骤（可留空，由 AI 拆解）">
            <Form.List name="steps">{(fields, { add, remove }) => (
              <div className={styles.stepEditor}>
                {fields.map((field, index) => (
                  <div key={field.key} className={styles.stepEditorRow}>
                    <span className={styles.stepIndex}>{index + 1}</span>
                    <Form.Item name={[field.name, 'text']} noStyle><Input placeholder="步骤内容" /></Form.Item>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                  </div>
                ))}
                <Button size="small" icon={<PlusOutlined />} onClick={() => add({ text: '' })}>添加步骤</Button>
              </div>
            )}</Form.List>
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={importOpen} title="导入 TodoList" onCancel={() => setImportOpen(false)} onOk={() => void submitImport()} okText="导入" width={680} destroyOnClose>
        <Form form={importForm} layout="vertical" initialValues={{ format: 'auto' }}>
          <div className={styles.formRow}>
            <Form.Item name="format" label="格式"><Select options={[{ label: '自动识别', value: 'auto' }, { label: 'Markdown 清单', value: 'markdown' }, { label: 'Todoist JSON', value: 'todoist' }, { label: 'Trello JSON', value: 'trello' }, { label: 'CSV', value: 'csv' }, { label: '通用 JSON', value: 'json' }]} /></Form.Item>
            <Form.Item name="workspacePath" label="导入后绑定 Work 工作区"><Select allowClear showSearch options={requirementWorkspaceOptions} placeholder="留空则先进入想法池" /></Form.Item>
          </div>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '粘贴要导入的内容' }]}><Input.TextArea rows={10} placeholder="支持 - [ ] 任务、Todoist/Trello 导出 JSON、CSV 或通用 JSON。" /></Form.Item>
        </Form>
      </Modal>

      <Modal open={schedulerOpen} title="调度器配置" onCancel={() => setSchedulerOpen(false)} onOk={() => void saveSchedulerSettings()} okText="保存" width={560} destroyOnClose>
        <Form form={schedulerForm} layout="vertical">
          {schedulerProvider && !schedulerOptionsLoading && !schedulerProviderAvailable ? (
            <div className={styles.inlineError} role="status">
              <ExclamationCircleOutlined /> 当前 Provider「{schedulerProvider}」在此服务器没有可用账号；请重新选择，或先在账号管理里添加账号。
            </div>
          ) : null}
          {!schedulerProvider && !schedulerOptionsLoading ? (
            <div className={styles.inlineNote} role="status"><ExclamationCircleOutlined /> 尚未选择 Provider/Model；保存前请从可用账号中选择。</div>
          ) : null}
          <Form.Item name="enabled" label="自动调度" valuePropName="checked"><Switch checkedChildren="启用" unCheckedChildren="暂停" /></Form.Item>
          <Form.Item name="serverProfileId" label="执行 Server" extra="留空在当前 Server 执行；选择远端 Server 时，工作区、账号与模型目录都按目标 Server 加载。">
            <Select options={schedulerServerOptions} onChange={handleSchedulerServerChange} placeholder="本地（当前 Server）" />
          </Form.Item>
          <Form.Item name="serverLabel" hidden><Input /></Form.Item>
          {schedulerOptionsError ? <div className={styles.inlineError} role="status"><ExclamationCircleOutlined /> {schedulerOptionsError}</div> : null}
          <div className={styles.formRow}>
            <Form.Item name="provider" label="Provider">
              <Select loading={schedulerOptionsLoading} options={schedulerProviderOptions} onChange={handleSchedulerProviderChange} showSearch placeholder="选择有可用账号的 Provider" />
            </Form.Item>
            <Form.Item name="model" label="Model">
              <Select loading={schedulerOptionsLoading} options={schedulerModelOptions} onChange={handleSchedulerModelChange} showSearch placeholder="选择该 Provider 的模型" />
            </Form.Item>
          </div>
          <div className={styles.formRow}>
            <Form.Item name="accountRef" label="执行账号" extra="留空自动选号；只显示当前 Provider 的账号">
              <Select
                loading={schedulerOptionsLoading}
                options={schedulerAccountOptions}
                showSearch
                allowClear
                placeholder="自动选号（推荐）"
              />
            </Form.Item>
            <Form.Item
              name="reasoningEffort"
              label="思考强度"
              extra={derivedSchedulerEffort
                ? '该模型的思考强度由模型 ID 决定'
                : schedulerIndependentEffort
                  ? 'Codex 原生会话会消费这个 effort'
                  : schedulerProvider === 'agy'
                    ? 'AGY 不提供独立 effort，模型变体即强度'
                    : '该 Provider 暂不暴露独立 effort，使用默认值'}
            >
              <Select disabled={schedulerEffortDisabled} options={schedulerEffortOptions} />
            </Form.Item>
          </div>
          <Form.Item name="maxParallel" label="全局最大并行数"><InputNumber min={1} max={8} style={{ width: '100%' }} /></Form.Item>
          <div className={styles.muted}>Provider / 模型 / 执行账号均来自当前服务器的可用账号与模型目录；执行账号留空即自动选号。AGY 的思考强度编码在模型变体（如 -low / -high / -xhigh）中，选中模型即选中强度。</div>
        </Form>
      </Modal>
    </main>
  );
}
