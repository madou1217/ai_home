import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Typography, message } from 'antd';
import { toolkitAPI } from '@/services/api';
import type { NativeResourceKind, NativeResourceReport } from '@/types';
import {
  KIND_LABELS,
  RESOURCE_KINDS,
  ownerOptions,
  ownerPayload
} from './native-resource-grouping';

interface Props {
  open: boolean;
  report: NativeResourceReport | null;
  initialKind: NativeResourceKind;
  onClose: () => void;
  onInstalled: (kind: NativeResourceKind) => void;
}

interface InstallFormValues {
  kind: NativeResourceKind;
  owners: string[];
  source: string;
  name?: string;
}

export default function NativeResourceInstallModal({
  open,
  report,
  initialKind,
  onClose,
  onInstalled
}: Props) {
  const [form] = Form.useForm<InstallFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [candidate, setCandidate] = useState<string>();
  const kind = Form.useWatch('kind', form) || initialKind;
  const candidates = useMemo(
    () => (report?.installCandidates || []).filter((item) => item.kind === kind),
    [report, kind]
  );
  const owners = useMemo(() => ownerOptions(report, kind), [report, kind]);

  useEffect(() => {
    if (!open) return;
    setCandidate(undefined);
    form.setFieldsValue({ kind: initialKind, owners: [], source: '', name: undefined });
  }, [open, initialKind, form]);

  const submit = async () => {
    const values = await form.validateFields();
    const selectedKind = values.kind;
    const targets = values.owners;
    setSubmitting(true);
    try {
      const results = await Promise.allSettled(targets.map((owner) => toolkitAPI.operateNativeResource({
        kind: selectedKind,
        action: 'install',
        source: values.source.trim(),
        ...(selectedKind === 'mcp' ? { id: values.name?.trim() } : {}),
        ...ownerPayload(owner)
      })));
      const failed = results
        .map((result, index) => ({ result, owner: targets[index] }))
        .filter((item) => item.result.status === 'rejected');
      const succeeded = targets.length - failed.length;
      if (succeeded > 0) onInstalled(selectedKind);
      if (!failed.length) {
        message.success(`${KIND_LABELS[selectedKind]} ${values.source.trim()} 已安装到 ${targets.length} 个目标`);
        onClose();
        return;
      }
      const first = failed[0].result as PromiseRejectedResult;
      const reason = first.reason instanceof Error ? first.reason.message : '安装失败';
      message.warning(`已安装 ${succeeded}/${targets.length}；${first.owner} 失败：${reason}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="安装原生资源"
      okText="安装"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="kind" label="资源类型" rules={[{ required: true, message: '请选择资源类型' }]}>
          <Select
            options={RESOURCE_KINDS.map((item) => ({ value: item, label: KIND_LABELS[item] }))}
            onChange={() => {
              setCandidate(undefined);
              form.setFieldsValue({ owners: [], source: '', name: undefined });
            }}
          />
        </Form.Item>
        {kind === 'mcp' ? (
          <Form.Item
            name="name"
            label="MCP 名称"
            rules={[
              { required: true, message: '请填写 MCP 名称' },
              { pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/, message: '仅支持小写字母、数字与 ._-' }
            ]}
          >
            <Input placeholder="例如 filesystem" autoComplete="off" />
          </Form.Item>
        ) : null}
        {candidates.length ? (
          <Form.Item label="随包提供的源">
            <Select
              allowClear
              value={candidate}
              placeholder="选择内置资源，或直接填写下方路径"
              options={candidates.map((item) => ({
                value: item.source,
                label: `${item.id}（${item.source}）`
              }))}
              onChange={(value?: string) => {
                setCandidate(value);
                form.setFieldsValue({ source: value || '' });
              }}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          name="source"
          label={kind === 'mcp' ? 'Node 脚本路径' : '安装源路径'}
          rules={[{ required: true, message: '请填写安装源路径' }]}
          extra={
            <Typography.Text type="secondary">
              必须是随安装包交付的目录或脚本，路径相对安装包根目录。
              {kind === 'skill' ? ' Skill 目录需包含 SKILL.md。' : ''}
              {kind === 'plugin' ? ' 插件目录需包含 package.json 与 agentPlugin 声明。' : ''}
            </Typography.Text>
          }
        >
          <Input
            placeholder={kind === 'skill' ? 'assets/provider-skills/aih-collab' : 'assets/native-plugins/<plugin>'}
            autoComplete="off"
          />
        </Form.Item>
        <Form.Item
          name="owners"
          label={(
            <Space size={8}>
              <span>安装到（可多选）</span>
              <Button
                size="small"
                type="link"
                onClick={() => form.setFieldsValue({ owners: owners.map((item) => item.value) })}
              >全选可用目标</Button>
            </Space>
          )}
          rules={[{ required: true, message: '请选择至少一个 Provider 或宿主' }]}
        >
          <Select
            mode="multiple"
            showSearch
            maxTagCount="responsive"
            placeholder="选择一个或多个 Provider / 宿主"
            options={owners}
            optionFilterProp="label"
          />
        </Form.Item>
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">安装后可在此页按宿主逐一启用、停用或移除。</Typography.Text>
        </Space>
      </Form>
    </Modal>
  );
}
