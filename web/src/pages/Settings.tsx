import { useState, useEffect } from 'react';
import { Card, Form, InputNumber, Button, message, Divider, Space } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { configAPI } from '@/services/api';
import type { UsageConfig } from '@/types';

const Settings = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const config = await configAPI.get();
      form.setFieldsValue({
        threshold_pct: config.threshold_pct,
        active_refresh_interval: parseInterval(config.active_refresh_interval),
        background_refresh_interval: parseInterval(config.background_refresh_interval)
      });
    } catch (error) {
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
      message.success('保存配置成功');
    } catch (error) {
      message.error('保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <Card loading={loading}>
        <Form
          form={form}
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
                保存设置
              </Button>
              <Button onClick={loadConfig}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default Settings;
