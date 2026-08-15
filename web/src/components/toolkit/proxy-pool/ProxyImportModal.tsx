import { Alert, Form, Input, Modal, Tabs, Typography, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { proxyPoolAPI } from '@/services/api';
import {
  getErrorMessage,
  getMutationMessage,
  isHttpUrl,
  isMutationApplied
} from './proxy-pool-utils';
import ConfigCodeEditor from '../config-editor/ConfigCodeEditor';

const { Paragraph } = Typography;
const { Dragger } = Upload;

type ImportMode = 'text' | 'subscription' | 'qr';

interface BarcodeDetectionResult {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<BarcodeDetectionResult[]>;
}

interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorInstance;
}

interface ProxyImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void> | void;
}

export default function ProxyImportModal({ open, onClose, onImported }: ProxyImportModalProps) {
  const [mode, setMode] = useState<ImportMode>('text');
  const [content, setContent] = useState('');
  const [importing, setImporting] = useState(false);
  const [subscriptionForm] = Form.useForm();

  const importText = async () => {
    if (!content.trim()) {
      message.warning('请粘贴节点链接或配置文本');
      return;
    }
    if (isHttpUrl(content.trim())) {
      message.warning('订阅地址请切换到“订阅 URL”，系统不会把 URL 误当作 HTTP 代理节点');
      return;
    }
    setImporting(true);
    try {
      const result = await proxyPoolAPI.importNodes(content);
      if (!result.ok || result.count === 0) {
        message.error(result.error || '没有识别到可支持的节点');
        return;
      }
      message.success(`已导入 ${result.count} 个节点`);
      setContent('');
      onClose();
      await onImported();
    } catch (error) {
      message.error(getErrorMessage(error, '导入失败'));
    } finally {
      setImporting(false);
    }
  };

  const importSubscription = async () => {
    setImporting(true);
    try {
      const values = await subscriptionForm.validateFields();
      const saved = await proxyPoolAPI.upsertSubscription(values);
      if (!saved.ok) throw new Error('订阅源保存失败');
      const synced = await proxyPoolAPI.syncSubscription(saved.subscription.id);
      if (!isMutationApplied(synced)) {
        message.warning(getMutationMessage(synced, '订阅已保存，但首次同步未应用'));
      } else {
        message.success(`订阅已保存并同步 ${synced.count || 0} 个节点`);
      }
      subscriptionForm.resetFields();
      onClose();
      await onImported();
    } catch (error) {
      if ((error as { errorFields?: unknown[] })?.errorFields) return;
      message.error(getErrorMessage(error, '订阅导入失败'));
    } finally {
      setImporting(false);
    }
  };

  const readQrCode = async (file: File) => {
    const BarcodeDetector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!BarcodeDetector) {
      message.error('当前浏览器不支持本地二维码识别，请使用最新版 Chromium 或粘贴二维码原文');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const results = await detector.detect(bitmap);
      bitmap.close();
      const decoded = results[0]?.rawValue?.trim();
      if (!decoded) {
        message.error('图片中没有识别到二维码');
        return;
      }
      if (isHttpUrl(decoded)) {
        setMode('subscription');
        subscriptionForm.setFieldsValue({ name: file.name.replace(/\.[^.]+$/, ''), url: decoded });
        message.success('已识别订阅 URL，请确认名称后导入');
      } else {
        setMode('text');
        setContent(decoded);
        message.success('已识别节点内容，请确认后导入');
      }
    } catch (error) {
      message.error(getErrorMessage(error, '二维码识别失败'));
    }
  };

  return (
    <Modal
      title="导入代理节点或订阅"
      open={open}
      confirmLoading={importing}
      onOk={() => void (mode === 'subscription' ? importSubscription() : importText())}
      okButtonProps={{ disabled: mode === 'qr' }}
      okText={mode === 'subscription' ? '保存并同步' : '导入节点'}
      onCancel={onClose}
      width={920}
    >
      <Tabs
        activeKey={mode}
        onChange={(key) => setMode(key as ImportMode)}
        items={[
          {
            key: 'text',
            label: '节点 / 配置文本',
            children: (
              <>
                <Paragraph type="secondary">
                  支持当前解析器明确识别的单节点链接、Base64 节点列表和 Mihomo/Clash YAML。HTTP(S) 订阅地址不会在这里被误解析为代理节点。
                </Paragraph>
                <ConfigCodeEditor
                  ariaLabel="节点或配置文本"
                  value={content}
                  onChange={setContent}
                  format="auto"
                  detectContent
                  height={340}
                />
              </>
            )
          },
          {
            key: 'subscription',
            label: '订阅 URL',
            children: (
              <Form form={subscriptionForm} layout="vertical">
                <Alert
                  type="info"
                  showIcon
                  message="首次导入会立即发起一次受限同步"
                  description="当前版本只承诺手动同步；不会显示并不存在的后台定时任务。服务端会校验协议、响应大小和内网目标。"
                />
                <Form.Item
                  label="订阅名称"
                  name="name"
                  rules={[{ required: true, whitespace: true, message: '请输入订阅名称' }]}
                >
                  <Input placeholder="例如：机场 A" />
                </Form.Item>
                <Form.Item
                  label="订阅 URL"
                  name="url"
                  rules={[
                    { required: true, message: '请输入订阅 URL' },
                    { validator: async (_rule, value) => {
                      if (value && !isHttpUrl(value)) throw new Error('仅支持 http:// 或 https:// URL');
                    } }
                  ]}
                >
                  <Input placeholder="https://example.com/subscribe?..." autoComplete="off" />
                </Form.Item>
              </Form>
            )
          },
          {
            key: 'qr',
            label: '二维码图片',
            children: (
              <Dragger
                accept="image/*"
                multiple={false}
                showUploadList={false}
                beforeUpload={(file) => {
                  void readQrCode(file);
                  return Upload.LIST_IGNORE;
                }}
              >
                <p className="ant-upload-drag-icon"><UploadOutlined /></p>
                <p className="ant-upload-text">选择或拖入二维码图片</p>
                <p className="ant-upload-hint">图片只在当前浏览器本地识别，不会上传到服务器。</p>
              </Dragger>
            )
          }
        ]}
      />
    </Modal>
  );
}
