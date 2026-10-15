import { useEffect, useState } from 'react';
import { Button, Form, InputNumber, Modal, Space, Spin, Switch, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import { formatTimeCell } from '@/utils/datetime';
import {
  describeWindowActivationGlobal,
  formatWindowActivationInterval
} from '@/features/accounts/window-activation-presentation';
import type {
  Account,
  AccountWindowActivationGlobalState,
  AccountWindowActivationProbeState
} from '@/types';
import './account-overlays.css';

interface AccountWindowActivationFormValues {
  enabled: boolean;
  intervalMinutes?: number | null;
}

interface AccountWindowActivationModalProps {
  account: Account | null;
  onClose: () => void;
}

const MS_PER_MINUTE = 60 * 1000;

// 与后端路由的下限一致（1 分钟）。
const MIN_INTERVAL_MINUTES = 1;

// 全局闸门状态标签色：生效=绿、未开启=黄、宿主未上报=灰。仅用紧凑标签表达，不做整块提示。
const GLOBAL_TONE_COLORS: Record<'active' | 'inactive' | 'unknown', string> = {
  active: 'success',
  inactive: 'warning',
  unknown: 'default'
};

function msToMinutes(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / MS_PER_MINUTE);
}

export function AccountWindowActivationModal({ account, onClose }: AccountWindowActivationModalProps) {
  const [form] = Form.useForm<AccountWindowActivationFormValues>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [globalState, setGlobalState] = useState<AccountWindowActivationGlobalState | null>(null);
  const [lastProbe, setLastProbe] = useState<AccountWindowActivationProbeState | null>(null);
  const accountEnabled = Form.useWatch('enabled', form) === true;

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setLoading(true);
    setGlobalState(null);
    setLastProbe(null);
    form.setFieldsValue({ enabled: false, intervalMinutes: undefined });

    accountsAPI.getAccountWindowActivation(account.provider, account.accountRef)
      .then((response) => {
        if (cancelled) return;
        const setting = response.setting || { enabled: false, intervalMs: null };
        form.setFieldsValue({
          enabled: Boolean(setting.enabled),
          intervalMinutes: msToMinutes(setting.intervalMs)
        });
        setGlobalState(response.global || null);
        setLastProbe(response.lastProbe || null);
      })
      .catch(() => {
        if (!cancelled) message.error('读取窗口激活设置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [account, form]);

  // 逐账号开关只是两道闸门之一：全局没开时必须说清楚「现在不会探测」。
  const globalView = describeWindowActivationGlobal({
    global: globalState,
    lastProbe,
    lastProbeRelative: formatTimeCell(lastProbe?.at)?.relative || null,
    accountEnabled
  });
  const defaultIntervalText = formatWindowActivationInterval(globalState?.defaultIntervalMs);
  const intervalHint = defaultIntervalText
    ? `留空则跟随全局默认间隔（当前为 ${defaultIntervalText}）。`
    : '留空则跟随全局默认间隔。';

  const save = async () => {
    if (!account || submitting) return;
    let values: AccountWindowActivationFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const minutes = values.intervalMinutes;
    const intervalMs = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? Math.floor(minutes * MS_PER_MINUTE)
      : null;
    setSubmitting(true);
    try {
      await accountsAPI.saveAccountWindowActivation(account.provider, account.accountRef, {
        enabled: Boolean(values.enabled),
        intervalMs
      });
      if (values.enabled && globalView.tone !== 'active') {
        message.warning('已开启窗口激活，但全局开关未生效，当前不会发送探测');
      } else {
        message.success(values.enabled ? '已开启窗口激活' : '已关闭窗口激活');
      }
      onClose();
    } catch (error: any) {
      const code = error?.response?.data?.error;
      message.error(code ? `保存窗口激活设置失败：${code}` : error?.message || '保存窗口激活设置失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(account)}
      title={account ? `窗口激活 · ${getAccountPrimaryLabel(account)}` : '窗口激活'}
      width={560}
      destroyOnHidden
      maskClosable={!submitting}
      onCancel={onClose}
      footer={[
        <Button key="cancel" disabled={submitting} onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={submitting} disabled={loading} onClick={() => void save()}>
          保存
        </Button>
      ]}
    >
      <Spin spinning={loading}>
        <Typography.Paragraph type="secondary">
          部分账号（如 Codex Plus）的限额按 5 小时滚动窗口计算，窗口只有在账号被真正使用时才会推进。
          开启后，AIH 会每隔一段时间用该账号发一个极小探测请求，把窗口「激活」。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          探测走网关数据面、不进入任何项目会话。默认关闭；仅对识别出 5 小时窗口的账号生效。
        </Typography.Paragraph>
        <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
          <Space size={8} wrap>
            <Tag color={GLOBAL_TONE_COLORS[globalView.tone]}>{globalView.label}</Tag>
            <Typography.Text type="secondary">{globalView.text}</Typography.Text>
          </Space>
          {globalView.hints.map((hint) => (
            <Typography.Text key={hint} type="secondary">
              {hint}
            </Typography.Text>
          ))}
        </Space>
        <Form form={form} layout="vertical" initialValues={{ enabled: false }}>
          <Form.Item name="enabled" label="开启窗口激活" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <Form.Item
            name="intervalMinutes"
            label="探测间隔（分钟）"
            extra={intervalHint}
            rules={[{
              validator: (_rule, value) => (
                value === undefined || value === null || (Number.isFinite(Number(value)) && Number(value) >= MIN_INTERVAL_MINUTES)
                  ? Promise.resolve()
                  : Promise.reject(new Error(`间隔不得小于 ${MIN_INTERVAL_MINUTES} 分钟`))
              )
            }]}
          >
            <InputNumber min={MIN_INTERVAL_MINUTES} step={30} style={{ width: 200 }} addonAfter="分钟" placeholder="跟随默认" />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
