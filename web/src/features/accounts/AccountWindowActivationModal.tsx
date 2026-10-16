import { useEffect, useState } from 'react';
import { Button, Form, InputNumber, Modal, Space, Spin, Switch, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import { formatTimeCell } from '@/utils/datetime';
import {
  describeWindowActivationGlobal,
  describeWindowActivationWindow,
  formatWindowActivationInterval
} from '@/features/accounts/window-activation-presentation';
import type {
  Account,
  AccountWindowActivationGlobalState,
  AccountWindowActivationProbeState,
  AccountWindowActivationWindowState
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

// 间隔下限的兜底值（分钟）：与调度器默认 windowActivationMinIntervalMs 同源（1 小时）。
// 运行时优先用服务端上报的 global.minIntervalMs，保证「控件允许的值 = 调度器接受的值」。
const FALLBACK_MIN_INTERVAL_MINUTES = 60;

// 全局闸门状态标签色：生效=绿、未开启=黄、宿主未上报=灰。仅用紧凑标签表达，不做整块提示。
const GLOBAL_TONE_COLORS: Record<'active' | 'inactive' | 'unknown', string> = {
  active: 'success',
  inactive: 'warning',
  unknown: 'default'
};

// 窗口状态标签色：运行中=绿、等待续窗/补窗=黄、观察不到=灰。
const WINDOW_TONE_COLORS: Record<'active' | 'inactive' | 'unknown', string> = {
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
  const [windowState, setWindowState] = useState<AccountWindowActivationWindowState | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const accountEnabled = Form.useWatch('enabled', form) === true;

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setLoading(true);
    setGlobalState(null);
    setLastProbe(null);
    setWindowState(null);
    setLoadedAt(0);
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
        setWindowState(response.window || null);
        setLoadedAt(Date.now());
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
  // 账号级窗口状态：与调度器决策同源，回答「窗口现在什么状态、下一步会不会续窗」。
  const windowView = describeWindowActivationWindow({
    window: windowState,
    // 关窗时刻用绝对时刻（相对时间读起来别扭，且跨天时会歧义）；判定时间用相对时间。
    closeAtText: formatTimeCell(windowState?.closeAtMs)?.absolute || null,
    decisionAtText: formatTimeCell(windowState?.lastDecision?.at)?.relative || null,
    decisionSinceMs: loadedAt,
    nowMs: loadedAt || undefined
  });
  const defaultIntervalText = formatWindowActivationInterval(globalState?.defaultIntervalMs);
  const intervalHint = defaultIntervalText
    ? `留空则跟随全局默认间隔（当前为 ${defaultIntervalText}）。能识别窗口时按关窗时刻续窗，这个间隔只在观察不到窗口时兜底。`
    : '留空则跟随全局默认间隔。能识别窗口时按关窗时刻续窗，这个间隔只在观察不到窗口时兜底。';
  const globalMinIntervalMs = Number(globalState?.minIntervalMs);
  const minIntervalMinutes = Number.isFinite(globalMinIntervalMs) && globalMinIntervalMs > 0
    ? Math.max(1, Math.round(globalMinIntervalMs / MS_PER_MINUTE))
    : FALLBACK_MIN_INTERVAL_MINUTES;

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
        <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
          <Space size={8} wrap>
            <Tag color={GLOBAL_TONE_COLORS[globalView.tone]}>{globalView.label}</Tag>
            <Typography.Text type="secondary">{globalView.text}</Typography.Text>
          </Space>
          {windowView ? (
            <Space size={8} wrap>
              <Tag color={WINDOW_TONE_COLORS[windowView.tone]}>{windowView.label}</Tag>
              <Typography.Text type="secondary">{windowView.text}</Typography.Text>
            </Space>
          ) : null}
          {windowView?.decision ? (
            <Typography.Text type="secondary">{windowView.decision}</Typography.Text>
          ) : null}
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
            label="兜底间隔（分钟）"
            extra={intervalHint}
            rules={[{
              validator: (_rule, value) => (
                value === undefined || value === null || (Number.isFinite(Number(value)) && Number(value) >= minIntervalMinutes)
                  ? Promise.resolve()
                  : Promise.reject(new Error(`间隔不得小于 ${minIntervalMinutes} 分钟`))
              )
            }]}
          >
            <InputNumber min={minIntervalMinutes} step={30} style={{ width: 200 }} addonAfter="分钟" placeholder="跟随默认" />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
