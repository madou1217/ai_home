import { Alert, Divider, Form, Input, Modal, Popconfirm, Space, Tag, Typography, message } from 'antd';
import { DeleteOutlined, SyncOutlined } from '@ant-design/icons';
import { useState } from 'react';
import Button from '@/components/ui/AppButton';
import { proxyPoolAPI } from '@/services/api';
import type { ProxySubscription } from '@/types';
import {
  formatLastSynced,
  getErrorMessage,
  getMutationMessage,
  isMutationApplied,
  isHttpUrl,
  maskSubscriptionUrl
} from './proxy-pool-utils';

const { Text } = Typography;

interface ProxySubscriptionsModalProps {
  open: boolean;
  subscriptions: ProxySubscription[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export default function ProxySubscriptionsModal({
  open,
  subscriptions,
  onClose,
  onChanged
}: ProxySubscriptionsModalProps) {
  const [form] = Form.useForm();
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const save = async (values: { name: string; url: string }) => {
    try {
      const result = await proxyPoolAPI.upsertSubscription(values);
      if (!result.ok) return;
      message.success('订阅源已保存；请手动同步');
      form.resetFields();
      await onChanged();
    } catch (error) {
      message.error(getErrorMessage(error, '保存订阅源失败'));
    }
  };

  const sync = async (id: string) => {
    setSyncingId(id);
    try {
      const result = await proxyPoolAPI.syncSubscription(id);
      if (isMutationApplied(result)) {
        message.success(`手动同步完成：${result.count || 0} 个节点`);
        await onChanged();
      } else {
        message.warning(getMutationMessage(result, '订阅同步未应用，原配置已保留'));
      }
    } catch (error) {
      message.error(getErrorMessage(error, '订阅同步失败'));
    } finally {
      setSyncingId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      const result = await proxyPoolAPI.deleteSubscription(id);
      if (!isMutationApplied(result)) {
        message.warning(getMutationMessage(result, '删除未应用，原订阅已保留'));
        return;
      }
      message.success('订阅及其节点已删除');
      await onChanged();
    } catch (error) {
      message.error(getErrorMessage(error, '删除订阅失败'));
    }
  };

  return (
    <Modal title="订阅源管理" open={open} onCancel={onClose} footer={null} width={700}>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
        <Space className="proxy-subscription-form" align="end" wrap>
          <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}>
            <Input placeholder="机场 A" />
          </Form.Item>
          <Form.Item
            label="URL"
            name="url"
            rules={[
              { required: true, message: '请输入 URL' },
              { validator: async (_rule, value) => {
                if (value && !isHttpUrl(value)) throw new Error('仅支持 http:// 或 https:// URL');
              } }
            ]}
          >
            <Input placeholder="https://example.com/subscribe?..." autoComplete="off" />
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit">保存</Button></Form.Item>
        </Space>
      </Form>
      <Alert
        type="info"
        showIcon
        message="当前为手动同步策略"
        description="autoUpdate 与 intervalHours 不会伪装成已运行的调度器。订阅地址中的 token 会在界面中遮罩。"
      />
      <Divider />
      <div className="proxy-subscription-list">
        {subscriptions.length === 0 ? (
          <Text type="secondary">尚未添加订阅源</Text>
        ) : subscriptions.map((subscription) => (
          <div key={subscription.id} className="toolkit-mirror-row">
            <div className="proxy-subscription-info">
              <Space wrap>
                <strong>{subscription.name}</strong>
                <Tag color="blue">{subscription.nodeCount} 个节点</Tag>
                <Tag>仅手动更新</Tag>
              </Space>
              <Text type="secondary" code title="敏感查询参数已遮罩">
                {maskSubscriptionUrl(subscription.url)}
              </Text>
              <Text type="secondary">上次同步：{formatLastSynced(subscription.lastSyncedAt)}</Text>
            </div>
            <Space>
              <Button
                size="small"
                icon={<SyncOutlined />}
                loading={syncingId === subscription.id}
                onClick={() => void sync(subscription.id)}
              >
                手动同步
              </Button>
              <Popconfirm title="删除该订阅及其节点？" onConfirm={() => void remove(subscription.id)}>
                <Button
                  aria-label={`删除订阅 ${subscription.name}`}
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>
            </Space>
          </div>
        ))}
      </div>
    </Modal>
  );
}
