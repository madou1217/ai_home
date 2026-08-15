import { Alert, Form, Input, Modal, Select, Space, Tag, Typography, message } from 'antd';
import { PlayCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  EnvironmentActionInput,
  EnvironmentActionPlan,
  EnvironmentActionResponse
} from '@/types';

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
  const [result, setResult] = useState<EnvironmentActionResponse | null>(null);
  const action = Form.useWatch('action', form) as EnvironmentActionInput['action'] | undefined;

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({ action: actions?.[0]?.value, path: '.venv' });
    setPlan(null);
    setPlannedInput(null);
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
    setResult(null);
    try {
      const input = await buildInput();
      const response = await toolkitAPI.planEnvironmentAction(input);
      if (!response.ok || !response.plan) throw new Error(response.message || response.error || '无法生成执行计划');
      setPlan(response.plan);
      setPlannedInput(input);
    } catch (error) {
      if ((error as { errorFields?: unknown[] })?.errorFields) return;
      message.error(apiError(error, '生成执行计划失败'));
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
          <Text type="secondary">执行范围：{plan.scope}。该操作不会改变已经打开的终端 Shell。</Text>
          {selectedAction?.danger && <Text type="danger">这是卸载或删除操作，请确认目标版本/环境无误。</Text>}
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

  return (
    <section className="toolkit-environment-action" aria-labelledby="toolkit-environment-action-title">
      <div className="toolkit-panel-kicker">STRUCTURED ACTION</div>
      <h3 id="toolkit-environment-action-title">受控执行</h3>
      <Alert
        type={detected ? 'info' : 'warning'}
        showIcon
        message={detected ? '先生成计划，再显式确认执行' : `${managerId} 未被当前 AIH 进程检测到`}
        description={detected
          ? '服务端只接受结构化参数和固定命令白名单，不接受任意 Shell。安装脚本类指南仍只允许复制。'
          : '可以继续查看和复制安装指南，但在管理器可被 PATH/用户目录探测到之前不会开放执行按钮。'}
      />
      <Form
        form={form}
        layout="inline"
        className="toolkit-environment-action-form"
        onValuesChange={() => {
          setPlan(null);
          setPlannedInput(null);
          setResult(null);
        }}
      >
        <Form.Item label="操作" name="action" rules={[{ required: true }]}>
          <Select style={{ minWidth: 180 }} options={actions} />
        </Form.Item>
        {manager !== 'conda' && manager !== 'venv' && (
          <Form.Item label="版本" name="version" rules={[{ required: true, message: '请输入版本' }]}>
            <Input placeholder={manager === 'pyenv' ? '3.12.7' : '22'} />
          </Form.Item>
        )}
        {manager === 'conda' && (
          <>
            <Form.Item label="环境名" name="name" rules={[{ required: true, message: '请输入环境名' }]}>
              <Input placeholder="analytics" />
            </Form.Item>
            {action === 'create' && (
              <Form.Item label="Python" name="pythonVersion" rules={[{ required: true, message: '请输入 Python 版本' }]}>
                <Input placeholder="3.12" />
              </Form.Item>
            )}
          </>
        )}
        {manager === 'venv' && (
          <Form.Item label="当前项目内目录" name="path" rules={[{ required: true, message: '请输入目录' }]}>
            <Input placeholder=".venv" />
          </Form.Item>
        )}
        <Form.Item>
          <Button loading={planning} onClick={() => void requestPlan()}>生成计划</Button>
        </Form.Item>
      </Form>

      {plan && (
        <div className="toolkit-action-plan">
          <Space wrap>
            <Tag color="blue">{plan.manager}</Tag>
            <Tag>{plan.action}</Tag>
            <Tag color={selectedAction?.danger ? 'error' : 'warning'}>会修改本机环境</Tag>
          </Space>
          <p>{plan.effect}</p>
          <pre tabIndex={0}><code>{planPreview(plan)}</code></pre>
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
        </div>
      )}

      {result && (
        <Alert
          type={result.ok ? 'success' : 'error'}
          showIcon
          message={result.ok ? '执行完成' : '执行失败'}
          description={(result.stdout || result.stderr || result.message || result.error || '').slice(0, 4000)}
        />
      )}
    </section>
  );
}
