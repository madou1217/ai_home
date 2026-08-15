import { Form, Input, InputNumber, Modal, Select, Space, Switch, message } from 'antd';
import { useEffect } from 'react';
import { proxyPoolAPI } from '@/services/api';
import type { ProxyNode, ProxyProtocol } from '@/types';
import { buildProxyNodePayload, getErrorMessage, PROTOCOL_OPTIONS } from './proxy-pool-utils';

interface ProxyNodeEditorModalProps {
  open: boolean;
  node: Partial<ProxyNode> | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export default function ProxyNodeEditorModal({
  open,
  node,
  onClose,
  onSaved
}: ProxyNodeEditorModalProps) {
  const [form] = Form.useForm();
  const protocol = Form.useWatch('protocol', form) as ProxyProtocol | undefined;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(node || {});
  }, [form, node, open]);

  const save = async () => {
    try {
      const values = await form.validateFields();
      const result = await proxyPoolAPI.upsertNode(buildProxyNodePayload(node || {}, values));
      if (!result.ok) return;
      message.success('节点已保存；启动或重载核心后进入数据面');
      onClose();
      await onSaved();
    } catch (error) {
      if ((error as { errorFields?: unknown[] })?.errorFields) return;
      message.error(getErrorMessage(error, '保存节点失败'));
    }
  };

  return (
    <Modal
      title={node?.id ? '编辑代理节点' : '添加代理节点'}
      open={open}
      onOk={() => void save()}
      onCancel={onClose}
      width={600}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item label="节点名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入节点名称' }]}>
          <Input placeholder="例如：香港 BGP 01" />
        </Form.Item>
        <Form.Item label="协议" name="protocol" rules={[{ required: true, message: '请选择协议' }]}>
          <Select options={PROTOCOL_OPTIONS.filter((item) => item.value !== 'all')} />
        </Form.Item>
        <Space className="toolkit-form-row" size={12} align="start">
          <Form.Item
            label="服务器地址"
            name="server"
            rules={[{ required: true, whitespace: true, message: '请输入服务器地址' }]}
          >
            <Input placeholder="proxy.example.com" />
          </Form.Item>
          <Form.Item label="端口" name="port" rules={[{ required: true, message: '请输入端口' }]}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
        </Space>

        {(protocol === 'vmess' || protocol === 'vless') && (
          <Form.Item label="UUID" name="uuid" rules={[{ required: true, whitespace: true, message: '请输入 UUID' }]}>
            <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </Form.Item>
        )}
        {protocol !== 'vmess' && protocol !== 'vless' && (
          <Form.Item
            label={protocol === 'socks5' || protocol === 'http' ? '密码（可选）' : '密码 / 密钥'}
            name="password"
            rules={protocol === 'socks5' || protocol === 'http'
              ? undefined
              : [{ required: true, message: '请输入密码或密钥' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        )}
        {(protocol === 'socks5' || protocol === 'http') && (
          <Form.Item label="用户名（可选）" name="username">
            <Input autoComplete="off" />
          </Form.Item>
        )}
        {protocol === 'shadowsocks' && (
          <Form.Item label="加密方式" name="cipher" rules={[{ required: true, message: '请输入 Shadowsocks 加密方式' }]}>
            <Input placeholder="aes-256-gcm / chacha20-ietf-poly1305" />
          </Form.Item>
        )}
        {(protocol === 'vmess' || protocol === 'vless') && (
          <Space className="toolkit-form-row" size={12} align="start">
            <Form.Item label="传输网络" name="network">
              <Select options={[
                { label: 'TCP', value: 'tcp' },
                { label: 'WebSocket', value: 'ws' },
                { label: 'gRPC', value: 'grpc' }
              ]} />
            </Form.Item>
            <Form.Item label="TLS" name="tls" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        )}
        {(protocol === 'vmess' || protocol === 'vless' || protocol === 'trojan' || protocol === 'hysteria2') && (
          <Space className="toolkit-form-row" size={12} align="start">
            <Form.Item label="SNI / Server name" name="sni">
              <Input placeholder="可选" />
            </Form.Item>
            {(protocol === 'vmess' || protocol === 'vless' || protocol === 'trojan') && (
              <Form.Item label="路径" name="path">
                <Input placeholder="/ws（可选）" />
              </Form.Item>
            )}
          </Space>
        )}
      </Form>
    </Modal>
  );
}
