import { Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import {
  CodeOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { toolkitAPI } from '@/services/api';
import type {
  EnvironmentActionInput,
  EnvironmentActionPlan,
  EnvironmentActionResponse
} from '@/types';
import './ToolkitPanels.css';

const { Text } = Typography;

type SupportedManager = EnvironmentActionInput['manager'];

const ACTIONS: Record<SupportedManager, Array<{ label: string; value: EnvironmentActionInput['action']; danger?: boolean }>> = {
  nvm: [
    { label: '安装版本', value: 'install' },
    { label: '卸载版本', value: 'uninstall', danger: true },
    { label: '设置新 Shell 默认版本', value: 'default' }
  ],
  fnm: [
    { label: '安装版本', value: 'install' },
    { label: '卸载版本', value: 'uninstall', danger: true },
    { label: '设置新 Shell 默认版本', value: 'default' }
  ],
  pyenv: [
    { label: '安装 Python', value: 'install' },
    { label: '卸载 Python', value: 'uninstall', danger: true },
    { label: '设置全局版本', value: 'global' }
  ],
  conda: [
    { label: '创建环境', value: 'create' },
    { label: '删除环境', value: 'remove', danger: true }
  ],
  venv: [{ label: '创建虚拟环境', value: 'create' }]
};

function apiError(error: unknown, fallback: string) {
  const candidate = error as { message?: string; response?: { data?: { message?: string; error?: string } } };
  return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
}

function planPreview(plan: EnvironmentActionPlan) {
  return JSON.stringify({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    cwd: plan.cwd,
    scope: plan.scope
  }, null, 2);
}

interface EnvironmentActionPanelProps {
  managerId: string;
  detected: boolean;
  onExecuted: () => Promise<void> | void;
}

export default function EnvironmentActionPanel({
  managerId,
  detected,
  onExecuted
}: EnvironmentActionPanelProps) {
  const manager = managerId as SupportedManager;
  const actions = ACTIONS[manager];
  const [form] = Form.useForm();
  const [plan, setPlan] = useState<EnvironmentActionPlan | null>(null);
  const [plannedInput, setPlannedInput] = useState<EnvironmentActionInput | null>(null);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [planError, setPlanError] = useState('');
  const [result, setResult] = useState<EnvironmentActionResponse | null>(null);
  const action = Form.useWatch('action', form) as EnvironmentActionInput['action'] | undefined;

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({ action: actions?.[0]?.value, path: '.venv' });
    setPlan(null);
    setPlannedInput(null);
    setPlanError('');
    setResult(null);
  }, [actions, form, managerId]);

  const selectedAction = useMemo(
    () => actions?.find((item) => item.value === action),
    [action, actions]
  );

  if (!actions) return null;

  const buildInput = async (): Promise<EnvironmentActionInput> => {
    const values = await form.validateFields();
    return { manager, ...values } as EnvironmentActionInput;
  };

  const requestPlan = async () => {
    setPlanning(true);
    setPlanError('');
    setResult(null);
    try {
      const input = await buildInput();
      const response = await toolkitAPI.planEnvironmentAction(input);
      if (!response.ok || !response.plan) throw new Error(response.message || response.error || '无法生成执行计划');
      setPlan(response.plan);
      setPlannedInput(input);
    } catch (error) {
      if ((error as { errorFields?: unknown[] })?.errorFields) return;
      const detail = apiError(error, '生成执行计划失败');
      setPlanError(detail);
      message.error(detail);
    } finally {
      setPlanning(false);
    }
  };

  const execute = () => {
    if (!plan || !plannedInput || !detected) return;
    Modal.confirm({
      title: '确认执行环境变更？',
      icon: <SafetyCertificateOutlined />,
      content: (
        <Space direction="vertical">
          <Text>{plan.effect}</Text>
          <Text type="secondary">执行范围：{plan.scope}。不会影响已打开的终端 Shell。</Text>
          {selectedAction?.danger && <Text type="danger">此操作会卸载或删除目标，请确认无误。</Text>}
        </Space>
      ),
      okText: '确认执行',
      okType: selectedAction?.danger ? 'danger' : 'primary',
      cancelText: '取消',
      async onOk() {
        setExecuting(true);
        try {
          const response = await toolkitAPI.executeEnvironmentAction({ ...plannedInput, confirmed: true });
          setResult(response);
          if (!response.ok) throw new Error(response.message || response.error || '环境操作执行失败');
          message.success('环境操作已执行完成');
          await onExecuted();
        } catch (error) {
          message.error(apiError(error, '环境操作执行失败'));
          throw error;
        } finally {
          setExecuting(false);
        }
      }
    });
  };

  const statusTag = executing
    ? <SettingStatusTag status="saving" label="执行中" compact />
    : result
      ? <SettingStatusTag status={result.ok ? 'applied' : 'error'} label={result.ok ? '已执行' : '失败'} compact />
      : detected
        ? <SettingStatusTag status="saved" label="已安装" compact />
        : <SettingStatusTag status="unset" label="未安装" compact />;

  return (
    <SettingSection
      title="受控执行"
      description="按结构化参数生成计划，经确认后仅执行白名单命令。"
      status={statusTag}
    >
      {!detected ? (
        <InlineNote tone="warning">
          {managerId} 未在当前 PATH 或用户目录中探测到，仅可预演计划，暂不可执行。
        </InlineNote>
      ) : null}

      <SettingRow
        title="参数配置"
        description="修改参数后需重新生成执行计划。"
        layout="stacked"
        control={(
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onValuesChange={() => {
              setPlan(null);
              setPlannedInput(null);
              setPlanError('');
              setResult(null);
            }}
          >
            <div className="toolkit-env-action-grid">
              <Form.Item label="操作" name="action" rules={[{ required: true }]}>
                <Select options={actions} />
              </Form.Item>
              {manager !== 'conda' && manager !== 'venv' ? (
                <Form.Item label="版本" name="version" rules={[{ required: true, message: '请输入版本' }]}>
                  <Input placeholder={manager === 'pyenv' ? '3.12.7' : '22'} />
                </Form.Item>
              ) : null}
              {manager === 'conda' ? (
                <>
                  <Form.Item label="环境名" name="name" rules={[{ required: true, message: '请输入环境名' }]}>
                    <Input placeholder="analytics" />
                  </Form.Item>
                  {action === 'create' ? (
                    <Form.Item label="Python 版本" name="pythonVersion" rules={[{ required: true, message: '请输入 Python 版本' }]}>
                      <Input placeholder="3.12" />
                    </Form.Item>
                  ) : null}
                </>
              ) : null}
              {manager === 'venv' ? (
                <Form.Item label="项目目录" name="path" rules={[{ required: true, message: '请输入目录' }]}>
                  <Input placeholder=".venv" />
                </Form.Item>
              ) : null}
            </div>
            <Space wrap style={{ marginTop: 12 }}>
              <Button icon={<CodeOutlined />} loading={planning} onClick={() => void requestPlan()}>
                生成计划
              </Button>
              {plan ? (
                <Button
                  type="primary"
                  danger={selectedAction?.danger}
                  icon={<PlayCircleOutlined />}
                  loading={executing}
                  disabled={!detected}
                  onClick={execute}
                >
                  审阅后执行
                </Button>
              ) : null}
            </Space>
          </Form>
        )}
      />

      {planError ? (
        <InlineNote tone="error" description={planError}>
          生成计划失败
        </InlineNote>
      ) : null}

      {plan ? (
        <SettingRow
          title="计划预览"
          description={plan.effect}
          layout="stacked"
          status={(
            <Space size={4} wrap>
              <Tag color="blue">{plan.manager}</Tag>
              <Tag>{plan.action}</Tag>
              <Tag color={selectedAction?.danger ? 'error' : 'warning'}>
                {selectedAction?.danger ? '将移除环境' : '将修改环境'}
              </Tag>
            </Space>
          )}
          control={(
            <pre className="toolkit-env-plan-pre" tabIndex={0}>
              <code>{planPreview(plan)}</code>
            </pre>
          )}
        />
      ) : null}

      {result ? (
        <InlineNote
          tone={result.ok ? 'success' : 'error'}
          description={(result.stdout || result.stderr || result.message || result.error || '').slice(0, 4000)}
        >
          {result.ok ? '执行完成' : '执行失败'}
        </InlineNote>
      ) : null}
    </SettingSection>
  );
}
