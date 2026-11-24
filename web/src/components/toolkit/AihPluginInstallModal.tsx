import { useEffect, useRef, useState } from 'react';
import { Checkbox, Input, Modal, Segmented, Space, Typography, message } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}

type InstallMode = 'url' | 'file';

export default function AihPluginInstallModal({ open, onClose, onInstalled }: Props) {
  const [mode, setMode] = useState<InstallMode>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [requireSigned, setRequireSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('url');
    setUrl('');
    setFile(null);
    setRequireSigned(false);
  }, [open]);

  const submit = async () => {
    if (mode === 'url' && !/^https?:\/\/\S+$/i.test(url.trim())) {
      message.warning('请填写 http(s) 插件包地址');
      return;
    }
    if (mode === 'file' && !file) {
      message.warning('请选择 .aih-plugin 包');
      return;
    }
    setSubmitting(true);
    try {
      const result = mode === 'url'
        ? await toolkitAPI.installAihPluginUrl(url.trim(), requireSigned)
        : await toolkitAPI.uploadAihPlugin(file as File, requireSigned);
      const installed = result as { pluginId?: string; version?: string };
      message.success(`AIH 插件 ${installed.pluginId || ''}${installed.version ? `@${installed.version}` : ''} 已安装`);
      onInstalled();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'AIH 插件安装失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="安装 AIH 能力插件"
      okText="安装"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented
          block
          value={mode}
          onChange={(value) => setMode(value as InstallMode)}
          options={[
            { value: 'url', label: 'URL' },
            { value: 'file', label: '本地包' }
          ]}
        />
        {mode === 'url' ? (
          <Input
            value={url}
            placeholder="https://example.com/plugin.aih-plugin"
            autoComplete="off"
            onChange={(event) => setUrl(event.target.value)}
          />
        ) : (
          <Space wrap>
            <Button icon={<FolderOpenOutlined />} onClick={() => fileInputRef.current?.click()}>
              选择 .aih-plugin
            </Button>
            <Typography.Text type="secondary">{file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : '未选择文件'}</Typography.Text>
            <input
              ref={fileInputRef}
              type="file"
              accept=".aih-plugin,application/octet-stream"
              style={{ display: 'none' }}
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                event.target.value = '';
              }}
            />
          </Space>
        )}
        <Checkbox checked={requireSigned} onChange={(event) => setRequireSigned(event.target.checked)}>
          要求已签名（拒绝未签名包）
        </Checkbox>
        <Typography.Text type="secondary">
          AIH 能力插件运行在 AIH 宿主内，可挂载账号、网关等能力槽；只安装可信来源。URL 由服务端下载。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
