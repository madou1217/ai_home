import { useEffect, useMemo, useState } from 'react';
import { Form, Input, Modal, Segmented, Typography } from 'antd';
import { isHttpUrl } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { parseBatchSources } from './aggregator-presentation';
import type { AggregatorSource } from './types';

const { Text } = Typography;

interface SourceEditorModalProps {
  open: boolean;
  /** 编辑已有订阅源；为空表示新增 */
  source: AggregatorSource | null;
  onClose: () => void;
  onSave: (source: { id?: string; name: string; url: string }) => Promise<boolean>;
  onSaveBatch: (sources: Array<{ name: string; url: string }>) => Promise<{ saved: number; failed: string[] }>;
}

/** 添加/编辑订阅源。新增时支持批量粘贴（每行一个），10 个订阅一次加完。 */
export default function SourceEditorModal({ open, source, onClose, onSave, onSaveBatch }: SourceEditorModalProps) {
  const [form] = Form.useForm<{ name: string; url: string }>();
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [batchText, setBatchText] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const batch = useMemo(() => parseBatchSources(batchText), [batchText]);

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setBatchText('');
    setFailures([]);
    form.setFieldsValue({ name: source?.name || '', url: source?.url || '' });
  }, [form, open, source]);

  const submit = async () => {
    setSaving(true);
    try {
      if (mode === 'batch') {
        if (!batch.sources.length) return;
        const result = await onSaveBatch(batch.sources);
        setFailures(result.failed);
        if (!result.failed.length) onClose();
        return;
      }
      const values = await form.validateFields();
      if (await onSave({ id: source?.id, name: values.name.trim(), url: values.url.trim() })) onClose();
    } catch (_validationError) {
      // 表单校验信息已就地显示。
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={source ? `编辑订阅源 · ${source.name}` : '添加订阅源'}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={mode === 'batch' ? `添加 ${batch.sources.length} 个` : '保存并同步'}
      okButtonProps={{ disabled: mode === 'batch' && !batch.sources.length }}
      confirmLoading={saving}
      destroyOnHidden
      width={640}
    >
      {!source && (
        <Segmented
          block
          value={mode}
          onChange={(value) => setMode(value as 'single' | 'batch')}
          options={[{ label: '单个添加', value: 'single' }, { label: '批量粘贴', value: 'batch' }]}
          style={{ marginBottom: 16 }}
        />
      )}
      {mode === 'single' ? (
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}>
            <Input placeholder="机场 A" maxLength={64} />
          </Form.Item>
          <Form.Item
            label="订阅地址"
            name="url"
            extra={source ? '修改地址后会立即重新同步。' : '保存后立即拉取一次，节点数与流量信息随之更新。'}
            rules={[
              { required: true, message: '请输入订阅地址' },
              { validator: async (_rule, value) => {
                if (value && !isHttpUrl(String(value).trim())) throw new Error('仅支持 http:// 或 https:// 地址');
              } }
            ]}
          >
            <Input placeholder="https://example.com/api/v1/client/subscribe?token=…" autoComplete="off" />
          </Form.Item>
        </Form>
      ) : (
        <>
          <Input.TextArea
            aria-label="批量订阅地址"
            value={batchText}
            onChange={(event) => setBatchText(event.target.value)}
            autoSize={{ minRows: 8, maxRows: 16 }}
            placeholder={'每行一个，名称可省略：\nhttps://a.example/sub?token=…\n机场B https://b.example/sub?token=…\n机场C,https://c.example/sub?token=…'}
          />
          <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            识别到 {batch.sources.length} 个订阅{batch.invalid.length ? `，${batch.invalid.length} 行无法识别：${batch.invalid.slice(0, 3).join('；')}` : ''}
          </Text>
          {failures.length > 0 && (
            <Text type="danger" style={{ display: 'block', marginTop: 8 }}>
              {failures.join('；')}
            </Text>
          )}
        </>
      )}
    </Modal>
  );
}
