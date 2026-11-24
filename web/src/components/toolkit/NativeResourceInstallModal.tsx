import { useEffect, useMemo, useRef, useState } from 'react';
import { Form, Input, Modal, Segmented, Select, Space, Typography, message } from 'antd';
import { CheckCircleOutlined, FolderOpenOutlined, LinkOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { toolkitAPI } from '@/services/api';
import type {
  NativeResourceKind,
  NativeResourceReport,
  NativeResourceSourceImport,
  NativeResourceSourceInspection
} from '@/types';
import {
  KIND_LABELS,
  RESOURCE_KINDS,
  ownerOptions,
  ownerPayload
} from './native-resource-grouping';
import './ToolkitPanels.css';

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

type SourceMode = 'path' | 'folder' | 'url';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativePathOf(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string };
  return withPath.webkitRelativePath || file.name;
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
  const [sourceMode, setSourceMode] = useState<SourceMode>('path');
  const [sourceUrl, setSourceUrl] = useState('');
  const [upload, setUpload] = useState<NativeResourceSourceImport | null>(null);
  const [inspection, setInspection] = useState<NativeResourceSourceInspection | null>(null);
  const [inspectError, setInspectError] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const kind = Form.useWatch('kind', form) || initialKind;
  const sourceValue = Form.useWatch('source', form) || '';
  const selectedOwners = Form.useWatch('owners', form) || [];
  const mcpName = Form.useWatch('name', form) || '';

  const candidates = useMemo(
    () => (report?.installCandidates || []).filter((item) => item.kind === kind),
    [report, kind]
  );
  const declaredTargets = useMemo(() => {
    if (sourceMode === 'path' && candidate) {
      return candidates.find((item) => item.source === candidate)?.targets;
    }
    if (sourceMode === 'path' && inspection?.targets?.length) return inspection.targets;
    if (sourceMode !== 'path' && upload) return upload.targets;
    return undefined;
  }, [sourceMode, candidate, candidates, inspection, upload]);
  const allOwners = useMemo(() => ownerOptions(report, kind), [report, kind]);
  const owners = useMemo(() => {
    if (!declaredTargets?.length) return allOwners;
    const allowed = new Set(declaredTargets);
    return allOwners.filter((option) => allowed.has(option.value.replace(/^(provider|host):/, '')));
  }, [allOwners, declaredTargets]);

  useEffect(() => {
    const allowed = new Set(owners.map((option) => option.value));
    const current = form.getFieldValue('owners') || [];
    const next = current.filter((value) => allowed.has(value));
    if (next.length !== current.length) form.setFieldsValue({ owners: next });
  }, [owners, form]);

  const resetSource = (mode: SourceMode) => {
    setSourceMode(mode);
    setCandidate(undefined);
    setSourceUrl('');
    setUpload(null);
    setInspection(null);
    setInspectError('');
    setImportError('');
    setSubmitError('');
    form.setFieldsValue({ source: '' });
  };

  useEffect(() => {
    if (!open) return;
    setCandidate(undefined);
    setSourceMode('path');
    setSourceUrl('');
    setUpload(null);
    setInspection(null);
    setInspectError('');
    setImportError('');
    setSubmitError('');
    form.setFieldsValue({ kind: initialKind, owners: [], source: '', name: undefined });
  }, [open, initialKind, form]);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const entries = Array.from(files)
      .filter((file) => {
        const rel = relativePathOf(file);
        return rel !== '.DS_Store' && !rel.split('/').includes('.git');
      })
      .map((file) => ({ path: relativePathOf(file), file }));
    if (!entries.length) {
      setImportError('所选文件夹没有可导入的文件');
      return;
    }
    setImporting(true);
    setImportError('');
    try {
      const result = await toolkitAPI.uploadNativeResourceSource(kind, entries);
      setUpload(result);
      form.setFieldsValue({ source: '' });
      message.success(`已导入 ${result.files} 个文件（${formatBytes(result.bytes)}）`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '文件夹导入失败';
      setImportError(detail);
      message.error(detail);
    } finally {
      setImporting(false);
    }
  };

  const importUrl = async () => {
    const value = sourceUrl.trim();
    if (!value) {
      setImportError('请先填写安装源 URL');
      return;
    }
    setImporting(true);
    setImportError('');
    try {
      const result = await toolkitAPI.importNativeResourceSourceUrl(kind, value);
      setUpload(result);
      form.setFieldsValue({ source: '' });
      message.success(`已导入 ${result.files} 个文件（${formatBytes(result.bytes)}）`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'URL 导入失败';
      setImportError(detail);
      message.error(detail);
    } finally {
      setImporting(false);
    }
  };

  const inspectPath = async () => {
    const value = String(form.getFieldValue('source') || '').trim();
    if (!value) {
      setInspection(null);
      setInspectError('');
      return;
    }
    setInspecting(true);
    try {
      setInspection(await toolkitAPI.inspectNativeResourceSource(kind, value));
      setInspectError('');
    } catch (error) {
      setInspection(null);
      setInspectError(error instanceof Error ? error.message : '预检失败');
    } finally {
      setInspecting(false);
    }
  };

  const hasSourceReady = sourceMode === 'path' ? Boolean(sourceValue.trim()) : Boolean(upload);
  const canSubmit = hasSourceReady
    && selectedOwners.length > 0
    && (kind !== 'mcp' || Boolean(mcpName.trim()))
    && !importing
    && !inspecting;

  const submit = async () => {
    setSubmitError('');
    const values = await form.validateFields();
    const source = values.source?.trim() || '';
    if (sourceMode === 'path' && !source) {
      setSubmitError('请填写安装源路径');
      return;
    }
    if (sourceMode !== 'path' && !upload) {
      setSubmitError(sourceMode === 'folder' ? '请先选择本地文件夹' : '请先下载 URL 安装源');
      return;
    }
    const selectedKind = values.kind;
    const targets = values.owners;
    setSubmitting(true);
    try {
      const sourcePayload = sourceMode === 'path' ? { source } : { uploadId: upload?.uploadId };
      const results = await Promise.allSettled(targets.map((owner) => toolkitAPI.operateNativeResource({
        kind: selectedKind,
        action: 'install',
        ...sourcePayload,
        ...(selectedKind === 'mcp' ? { id: values.name?.trim() } : {}),
        ...ownerPayload(owner)
      })));
      const failed = results
        .map((result, index) => ({ result, owner: targets[index] }))
        .filter((item) => item.result.status === 'rejected');
      const succeeded = targets.length - failed.length;
      if (succeeded > 0) onInstalled(selectedKind);
      const sourceLabel = sourceMode === 'path' ? source : upload?.name || '安装源';
      if (!failed.length) {
        message.success(`${KIND_LABELS[selectedKind]} ${sourceLabel} 已安装到 ${targets.length} 个目标`);
        onClose();
        return;
      }
      const first = failed[0].result as PromiseRejectedResult;
      const reason = first.reason instanceof Error ? first.reason.message : '安装失败';
      const warningText = `已安装 ${succeeded}/${targets.length}；${first.owner} 失败：${reason}`;
      setSubmitError(warningText);
      message.warning(warningText);
    } finally {
      setSubmitting(false);
    }
  };

  const sourceStatusTag = inspecting || importing
    ? <SettingStatusTag status="saving" label="校验中" compact />
    : inspectError || importError
      ? <SettingStatusTag status="error" label="失败" compact />
      : hasSourceReady
        ? <SettingStatusTag status="saved" label="已设定" compact />
        : <SettingStatusTag status="unset" label="未设定" compact />;

  return (
    <Modal
      open={open}
      title="安装原生资源"
      okText="安装"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: !canSubmit }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
      width={640}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <div className="toolkit-install-modal-section">
          <div className="toolkit-install-modal-section-head">
            <h4 className="toolkit-install-modal-section-title">1. 资源类型</h4>
            <SettingStatusTag status="saved" label={KIND_LABELS[kind]} compact />
          </div>
          <Form.Item name="kind" style={{ marginBottom: kind === 'mcp' ? 12 : 0 }} rules={[{ required: true, message: '请选择资源类型' }]}>
            <Select
              aria-label="资源类型"
              options={RESOURCE_KINDS.map((item) => ({ value: item, label: KIND_LABELS[item] }))}
              onChange={() => {
                resetSource('path');
                form.setFieldsValue({ owners: [], name: undefined });
              }}
            />
          </Form.Item>
          {kind === 'mcp' ? (
            <Form.Item
              name="name"
              label="MCP 名称"
              style={{ marginBottom: 0 }}
              rules={[
                { required: true, message: '请填写 MCP 名称' },
                { pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/, message: '仅支持小写字母、数字与 ._-' }
              ]}
            >
              <Input placeholder="例如 filesystem" autoComplete="off" />
            </Form.Item>
          ) : null}
        </div>

        <div className="toolkit-install-modal-section">
          <div className="toolkit-install-modal-section-head">
            <h4 className="toolkit-install-modal-section-title">2. 安装源</h4>
            {sourceStatusTag}
          </div>
          <Segmented
            block
            value={sourceMode}
            onChange={(value) => resetSource(value as SourceMode)}
            options={[
              { value: 'path', label: '内置 / 路径' },
              { value: 'folder', label: '本地文件夹' },
              { value: 'url', label: 'URL' }
            ]}
          />

          {sourceMode === 'path' ? (
            <>
              {candidates.length ? (
                <Form.Item label="内置候选源" style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    value={candidate}
                    placeholder="选择内置资源，或在下方手动填写路径"
                    options={candidates.map((item) => ({
                      value: item.source,
                      label: `${item.id}（${item.source}）`
                    }))}
                    onChange={(value?: string) => {
                      setCandidate(value);
                      setInspection(null);
                      setInspectError('');
                      form.setFieldsValue({ source: value || '' });
                    }}
                  />
                </Form.Item>
              ) : null}
              <Form.Item
                name="source"
                label={kind === 'mcp' ? 'Node 脚本路径' : '安装源路径'}
                style={{ marginBottom: 0 }}
                rules={[{ required: true, message: '请填写安装源路径' }]}
                extra={(
                  <Typography.Text type="secondary">
                    相对安装包根目录；
                    {kind === 'skill' ? 'Skill 目录需包含 SKILL.md。' : kind === 'plugin' ? '插件目录需包含 package.json 与 agentPlugin 声明。' : '需指向可执行脚本。'}
                  </Typography.Text>
                )}
              >
                <Input
                  placeholder={kind === 'skill' ? 'assets/provider-skills/aih-collab' : 'assets/native-plugins/<plugin>'}
                  autoComplete="off"
                  onChange={() => {
                    setInspection(null);
                    setInspectError('');
                  }}
                  onBlur={() => void inspectPath()}
                  addonAfter={(
                    <Button
                      size="small"
                      type="link"
                      icon={<CheckCircleOutlined />}
                      loading={inspecting}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void inspectPath()}
                    >
                      预检
                    </Button>
                  )}
                />
              </Form.Item>
              {inspectError ? (
                <InlineNote tone="error">预检失败：{inspectError}</InlineNote>
              ) : inspection ? (
                <InlineNote tone="success">
                  已预检：{inspection.id || '脚本'}
                  {inspection.version ? ` ${inspection.version}` : ''}
                  {inspection.targets?.length ? ` · 兼容目标 ${inspection.targets.join(' / ')}` : ' · 未限制目标'}
                </InlineNote>
              ) : declaredTargets?.length ? (
                <InlineNote tone="info">声明目标：{declaredTargets.join(' / ')}，下方目标列表已过滤。</InlineNote>
              ) : null}
            </>
          ) : null}

          {sourceMode === 'folder' ? (
            <>
              <Space wrap>
                <Button
                  icon={<FolderOpenOutlined />}
                  loading={importing}
                  onClick={() => folderInputRef.current?.click()}
                >
                  选择文件夹
                </Button>
                <Typography.Text type="secondary">单包上限 4MB、256 个文件。</Typography.Text>
              </Space>
              <input
                ref={(node) => {
                  folderInputRef.current = node;
                  node?.setAttribute('webkitdirectory', '');
                  node?.setAttribute('directory', '');
                }}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(event) => {
                  void importFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {upload ? (
                <InlineNote tone="success">
                  已导入：{upload.name || '文件夹'} · {upload.files} 个文件 · {formatBytes(upload.bytes)}
                  {upload.targets?.length ? ` · 兼容目标 ${upload.targets.join(' / ')}` : ''}
                </InlineNote>
              ) : null}
            </>
          ) : null}

          {sourceMode === 'url' ? (
            <>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={sourceUrl}
                  placeholder="https://example.com/plugin.zip"
                  autoComplete="off"
                  onChange={(event) => {
                    setSourceUrl(event.target.value);
                    setImportError('');
                  }}
                />
                <Button
                  icon={<LinkOutlined />}
                  loading={importing}
                  disabled={!sourceUrl.trim()}
                  onClick={() => void importUrl()}
                >
                  下载
                </Button>
              </Space.Compact>
              <Typography.Text type="secondary">支持 http(s) 直链，自动解包 zip / tar.gz / tar。</Typography.Text>
              {upload ? (
                <InlineNote tone="success">
                  已导入：{upload.name} · {upload.files} 个文件 · {formatBytes(upload.bytes)}
                  {upload.targets?.length ? ` · 兼容目标 ${upload.targets.join(' / ')}` : ''}
                </InlineNote>
              ) : null}
            </>
          ) : null}

          {importError ? <InlineNote tone="error">{importError}</InlineNote> : null}
        </div>

        <div className="toolkit-install-modal-section" style={{ marginBottom: 0 }}>
          <div className="toolkit-install-modal-section-head">
            <h4 className="toolkit-install-modal-section-title">3. 目标宿主</h4>
            <Space size={8}>
              <SettingStatusTag
                status={selectedOwners.length ? 'saved' : 'unset'}
                label={selectedOwners.length ? `已选 ${selectedOwners.length} 个` : '未设定'}
                compact
              />
              <Button
                size="small"
                type="link"
                disabled={!owners.length}
                onClick={() => form.setFieldsValue({ owners: owners.map((item) => item.value) })}
              >
                全选可用
              </Button>
            </Space>
          </div>
          <Form.Item
            name="owners"
            style={{ marginBottom: 0 }}
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
        </div>

        {submitError ? (
          <div style={{ marginTop: 12 }}>
            <InlineNote tone="error">{submitError}</InlineNote>
          </div>
        ) : null}
      </Form>
    </Modal>
  );
}
