import { useEffect, useMemo, useState } from 'react';
import { Form, Input, Modal, Segmented, Typography } from 'antd';
import { isHttpUrl } from '@/components/toolkit/proxy-pool/proxy-pool-utils';
import { LOCAL_SOURCE_MAX_BYTES, parseBatchSources, utf8ByteLength } from './aggregator-presentation';
import type { AggregatorSource, AggregatorSourceInput } from './types';

const { Text } = Typography;

type EditorMode = 'remote' | 'batch' | 'local';

interface SourceFormValues {
  name: string;
  url: string;
  userAgent: string;
  content: string;
}

interface SourceEditorModalProps {
  open: boolean;
  /** 编辑已有订阅源；为空表示新增 */
  source: AggregatorSource | null;
  /** 远程订阅默认的 User-Agent（服务端 catalog.defaultUserAgent） */
  defaultUserAgent: string;
  onClose: () => void;
  onSave: (source: AggregatorSourceInput) => Promise<boolean>;
  onSaveBatch: (sources: Array<{ name: string; url: string }>) => Promise<{ saved: number; failed: string[] }>;
}

const LOCAL_PLACEHOLDER = '每行一个分享链接（vless:// trojan:// ss:// hy2:// tuic:// …），\n或整段 Clash / sing-box / Surge / Loon / Quantumult X 配置、Base64 订阅内容';

/**
 * 添加/编辑订阅源：远程订阅地址（可批量粘贴，可按源指定 User-Agent），或本地内容
 * （粘贴自建节点或整段配置，保存即解析）。编辑时可在远程与本地之间切换。
 */
export default function SourceEditorModal({ open, source, defaultUserAgent, onClose, onSave, onSaveBatch }: SourceEditorModalProps) {
  const [form] = Form.useForm<SourceFormValues>();
  const [mode, setMode] = useState<EditorMode>('remote');
  const [batchText, setBatchText] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const batch = useMemo(() => parseBatchSources(batchText), [batchText]);

  useEffect(() => {
    if (!open) return;
    setMode(source?.kind === 'local' ? 'local' : 'remote');
    setBatchText('');
    setFailures([]);
    form.setFieldsValue({
      name: source?.name || '',
      url: source?.url || '',
      userAgent: source?.userAgent || '',
      content: source?.content || ''
    });
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
      const input: AggregatorSourceInput = mode === 'local'
        ? { id: source?.id, name: values.name.trim(), kind: 'local', content: values.content }
        : { id: source?.id, name: values.name.trim(), kind: 'remote', url: values.url.trim(), userAgent: values.userAgent.trim() };
      if (await onSave(input)) onClose();
    } catch (_validationError) {
      // 表单校验信息已就地显示。
    } finally {
      setSaving(false);
    }
  };

  const modeOptions = source
    ? [{ label: '订阅地址', value: 'remote' }, { label: '本地节点', value: 'local' }]
    : [{ label: '订阅地址', value: 'remote' }, { label: '批量粘贴地址', value: 'batch' }, { label: '本地节点', value: 'local' }];

  return (
    <Modal
      title={source ? `编辑订阅源 · ${source.name}` : '添加订阅源'}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={mode === 'batch' ? `添加 ${batch.sources.length} 个` : mode === 'local' ? '保存并解析' : '保存并同步'}
      okButtonProps={{ disabled: mode === 'batch' && !batch.sources.length }}
      confirmLoading={saving}
      destroyOnHidden
      width={640}
    >
      <Segmented
        block
        value={mode}
        onChange={(value) => setMode(value as EditorMode)}
        options={modeOptions}
        style={{ marginBottom: 16 }}
      />
      {mode === 'batch' ? (
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
      ) : (
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}>
            <Input placeholder={mode === 'local' ? '自建节点' : '机场 A'} maxLength={64} />
          </Form.Item>
          {mode === 'remote' ? (
            <>
              <Form.Item
                label="订阅地址"
                name="url"
                extra={source ? '修改地址或 User-Agent 后会立即重新同步。' : '保存后立即拉取一次，节点数与流量信息随之更新。'}
                rules={[
                  { required: true, message: '请输入订阅地址' },
                  { validator: async (_rule, value) => {
                    if (value && !isHttpUrl(String(value).trim())) throw new Error('仅支持 http:// 或 https:// 地址');
                  } }
                ]}
              >
                <Input placeholder="https://example.com/api/v1/client/subscribe?token=…" autoComplete="off" />
              </Form.Item>
              <Form.Item
                label="User-Agent"
                name="userAgent"
                extra="机场按 User-Agent 返回不同格式，一般留空即可；个别机场只认特定客户端时再填。"
                rules={[{ pattern: /^[\x20-\x7e]{0,200}$/, message: '只能是可见 ASCII 字符（最多 200 个）' }]}
              >
                <Input placeholder={`默认 ${defaultUserAgent}`} autoComplete="off" allowClear />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              label="节点内容"
              name="content"
              extra="保存后立即解析；以后可以随时编辑，同步即按最新的解析规则重读。"
              rules={[
                { required: true, whitespace: true, message: '请粘贴节点内容' },
                { validator: async (_rule, value) => {
                  if (value && utf8ByteLength(String(value)) > LOCAL_SOURCE_MAX_BYTES) throw new Error('内容超过 2 MB');
                } }
              ]}
            >
              <Input.TextArea
                aria-label="节点内容"
                autoSize={{ minRows: 8, maxRows: 16 }}
                placeholder={LOCAL_PLACEHOLDER}
                spellCheck={false}
              />
            </Form.Item>
          )}
        </Form>
      )}
    </Modal>
  );
}
