import { Form, Input, InputNumber, Modal, Select, Space, Switch, message } from 'antd';
import { useEffect } from 'react';
import { proxyPoolAPI } from '@/services/api';
import type { ProxyNode, ProxyProtocolField } from '@/types';
import { getErrorMessage } from './proxy-pool-utils';
import {
  buildProxyNodePayload,
  findProtocolPlugin,
  groupProtocolFields
} from './proxy-protocol-schema';
import { useProxyProtocols } from './use-proxy-protocols';

function renderFieldControl(field: ProxyProtocolField) {
  switch (field.type) {
    case 'password':
      return <Input.Password autoComplete="new-password" placeholder={field.placeholder} />;
    case 'number':
      return <InputNumber placeholder={field.placeholder} />;
    case 'select':
      return <Select options={field.options || []} placeholder={field.placeholder} />;
    case 'switch':
      return <Switch />;
    default:
      return <Input autoComplete="off" placeholder={field.placeholder} />;
  }
}

// 协议相关字段由服务端协议插件声明（editor.fields），这里按描述渲染。
function ProtocolField({ field }: { field: ProxyProtocolField }) {
  return (
    <Form.Item
      label={field.label}
      name={field.key}
      valuePropName={field.type === 'switch' ? 'checked' : undefined}
      rules={field.required
        ? [{ required: true, ...(field.type === 'switch' ? {} : { whitespace: true }), message: `请输入${field.label}` }]
        : undefined}
    >
      {renderFieldControl(field)}
    </Form.Item>
  );
}

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
  const protocol = Form.useWatch('protocol', form) as string | undefined;
  const { plugins, selectOptions } = useProxyProtocols();
  const fieldGroups = groupProtocolFields(findProtocolPlugin(plugins, protocol)?.editor.fields || []);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(node || {});
  }, [form, node, open]);

  const save = async () => {
    try {
      const values = await form.validateFields();
      const result = await proxyPoolAPI.upsertNode(buildProxyNodePayload(plugins, node || {}, values));
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
          <Select options={selectOptions} />
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

        {fieldGroups.map((group) => (group.length > 1 ? (
          <Space key={group.map((field) => field.key).join('-')} className="toolkit-form-row" size={12} align="start">
            {group.map((field) => <ProtocolField key={field.key} field={field} />)}
          </Space>
        ) : (
          <ProtocolField key={group[0].key} field={group[0]} />
        )))}
      </Form>
    </Modal>
  );
}
