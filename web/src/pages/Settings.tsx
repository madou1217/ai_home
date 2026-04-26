import { useState, useEffect } from 'react';
import { Card, Form, InputNumber, Button, Input, message, Divider, Space, Switch, Alert } from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import { configAPI, managementAPI } from '@/services/api';
import type { UsageConfig, ServerConfig } from '@/types';

const Settings = () => {
  const [usageForm] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverSaving, setServerSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const [config, serverConfig] = await Promise.all([
        configAPI.get(),
        configAPI.getServer()
      ]);
      usageForm.setFieldsValue({
        threshold_pct: config.threshold_pct,
        active_refresh_interval: parseInterval(config.active_refresh_interval),
        background_refresh_interval: parseInterval(config.background_refresh_interval)
      });
      serverForm.setFieldsValue(serverConfig);
    } catch (_error) {
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const parseInterval = (interval: string): number => {
    const match = interval.match(/^(\d+)([smh])$/);
    if (!match) return 60;
    const [, value, unit] = match;
    const num = parseInt(value);
    switch (unit) {
      case 's': return num;
      case 'm': return num * 60;
      case 'h': return num * 3600;
      default: return num;
    }
  };

  const formatInterval = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const config: UsageConfig = {
        threshold_pct: values.threshold_pct,
        active_refresh_interval: formatInterval(values.active_refresh_interval),
        background_refresh_interval: formatInterval(values.background_refresh_interval)
      };
      await configAPI.update(config);
      message.success('保存额度配置成功');
    } catch (_error) {
      message.error('保存额度配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveServer = async (values: ServerConfig) => {
    setServerSaving(true);
    try {
      const nextConfig: ServerConfig = {
        host: values.openNetwork ? '0.0.0.0' : (values.host || '127.0.0.1'),
        port: Number(values.port || 8317),
        apiKey: String(values.apiKey || '').trim(),
        managementKey: String(values.managementKey || '').trim(),
        openNetwork: Boolean(values.openNetwork)
      };
      await configAPI.updateServer(nextConfig);
      serverForm.setFieldsValue(nextConfig);
      message.success('保存服务配置成功');
    } catch (_error) {
      message.error('保存服务配置失败');
    } finally {
      setServerSaving(false);
    }
  };

  const handleRestartServer = async () => {
    setRestarting(true);
    try {
      await managementAPI.restart();
      message.success('已触发服务重启，请稍候刷新页面');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '重启服务失败');
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <Card loading={loading}>
        <Form
          form={usageForm}
          layout="vertical"
          onFinish={handleSave}
          initialValues={{
            threshold_pct: 95,
            active_refresh_interval: 60,
            background_refresh_interval: 3600
          }}
        >
          <Divider orientation="left">账号管理</Divider>

          <Form.Item
            name="threshold_pct"
            label="自动切换阈值 (%)"
            help="当账号剩余额度低于此百分比时，自动切换到下一个可用账号"
            rules={[
              { required: true, message: '请输入阈值' },
              { type: 'number', min: 0, max: 100, message: '阈值必须在 0-100 之间' }
            ]}
          >
            <InputNumber min={0} max={100} style={{ width: '100%' }} addonAfter="%" />
          </Form.Item>

          <Divider orientation="left">额度刷新</Divider>

          <Form.Item
            name="active_refresh_interval"
            label="活跃刷新间隔 (秒)"
            help="正在使用的账号额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 10, message: '间隔不能小于 10 秒' }
            ]}
          >
            <InputNumber min={10} style={{ width: '100%' }} addonAfter="秒" />
          </Form.Item>

          <Form.Item
            name="background_refresh_interval"
            label="后台刷新间隔 (秒)"
            help="未使用账号的额度刷新间隔时间"
            rules={[
              { required: true, message: '请输入刷新间隔' },
              { type: 'number', min: 60, message: '间隔不能小于 60 秒' }
            ]}
          >
            <InputNumber min={60} style={{ width: '100%' }} addonAfter="秒" />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
                保存额度设置
              </Button>
              <Button onClick={loadConfig}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <Form
          form={serverForm}
          layout="vertical"
          onFinish={handleSaveServer}
          initialValues={{
            host: '127.0.0.1',
            port: 8317,
            apiKey: '',
            managementKey: '',
            openNetwork: false
          }}
        >
          <Divider orientation="left">服务配置</Divider>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="开启开放网络后，Server 会监听 0.0.0.0。保存配置后，需要点击“一键重启服务”才会生效。"
          />

          <Form.Item
            name="openNetwork"
            label="开放网络访问"
            valuePropName="checked"
          >
            <Switch checkedChildren="开放" unCheckedChildren="仅本机" />
          </Form.Item>

          <Form.Item shouldUpdate noStyle>
            {() => {
              const openNetwork = serverForm.getFieldValue('openNetwork');
              return (
                <Form.Item
                  name="host"
                  label="监听地址"
                  help={openNetwork ? '开放网络时会自动使用 0.0.0.0' : '默认仅监听本机 127.0.0.1'}
                >
                  <Input disabled={openNetwork} placeholder="127.0.0.1" />
                </Form.Item>
              );
            }}
          </Form.Item>

          <Form.Item
            name="port"
            label="端口"
            rules={[
              { required: true, message: '请输入端口' },
              { type: 'number', min: 1, max: 65535, message: '端口必须在 1-65535 之间' }
            ]}
          >
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            help="用于访问 /v1 接口的客户端密钥。留空表示继续使用默认 dummy。"
          >
            <Input.Password placeholder="例如 sk-local-xxxx" />
          </Form.Item>

          <Form.Item
            name="managementKey"
            label="Management Key"
            help="用于 /v0/management 管理接口。可留空。"
          >
            <Input.Password placeholder="可选" />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={serverSaving}>
                保存服务配置
              </Button>
              <Button icon={<ReloadOutlined />} onClick={handleRestartServer} loading={restarting}>
                一键重启服务
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default Settings;
