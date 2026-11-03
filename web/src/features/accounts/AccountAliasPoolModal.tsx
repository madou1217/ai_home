import { useEffect, useState } from 'react';
import { Button, Form, Modal, Space, Spin, Switch, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import type { Account } from '@/types';
import './account-overlays.css';

interface AccountAliasPoolModalProps {
  account: Account | null;
  onClose: () => void;
}

/**
 * 账号级「是否进入别名自动选号池」。
 *
 * 只控制全局别名的自动选号：关闭后仍可被显式钉选（x-account-ref）或手动选择使用。
 * 状态保存在服务端（account:alias-pool:<ref>），写入后立即重载运行池。
 */
export function AccountAliasPoolModal({ account, onClose }: AccountAliasPoolModalProps) {
  const [form] = Form.useForm<{ participates: boolean }>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const participates = Form.useWatch('participates', form) !== false;

  useEffect(() => {
    if (!account) return undefined;
    let cancelled = false;
    setLoading(true);
    form.setFieldsValue({ participates: account.aliasPoolParticipates !== false });
    accountsAPI.getAccountAliasPool(account.provider, account.accountRef)
      .then((response) => {
        if (cancelled) return;
        form.setFieldsValue({ participates: response.setting?.participates !== false });
      })
      .catch(() => {
        if (!cancelled) message.error('读取别名选号设置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, form]);

  const save = async () => {
    if (!account || submitting) return;
    let values: { participates: boolean };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const response = await accountsAPI.saveAccountAliasPool(account.provider, account.accountRef, {
        participates: Boolean(values.participates)
      });
      if (response.reloaded === false) {
        message.warning('已保存，但运行池尚未重载；重启 Server 后生效');
      } else {
        message.success(values.participates ? '已加入别名自动选号池' : '已退出别名自动选号池');
      }
      onClose();
    } catch (error: any) {
      const code = error?.response?.data?.error;
      message.error(code ? `保存别名选号设置失败：${code}` : error?.message || '保存别名选号设置失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(account)}
      title={account ? `别名选号 · ${getAccountPrimaryLabel(account)}` : '别名选号'}
      width={520}
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
        <Space direction="vertical" size={6} style={{ marginBottom: 16 }}>
          <Space size={8} wrap>
            <Tag color={participates ? 'success' : 'default'}>
              {participates ? '参与自动选号' : '不参与自动选号'}
            </Tag>
            <Typography.Text type="secondary">
              全局别名命中模型时，网关是否自动把这个账号拉进候选池。
            </Typography.Text>
          </Space>
          <Typography.Text type="secondary">
            关闭后仍可用账号位显式启动或手动选择；显式钉选不受影响。
          </Typography.Text>
        </Space>
        <Form form={form} layout="vertical" initialValues={{ participates: true }}>
          <Form.Item name="participates" label="进入别名自动选号池" valuePropName="checked">
            <Switch checkedChildren="参与" unCheckedChildren="不参与" />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
