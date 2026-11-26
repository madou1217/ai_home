import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Segmented, Select, Space, Typography, message } from 'antd';
import { FolderOpenOutlined, LinkOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
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
  link?: boolean;
  mcpTransport?: 'stdio' | 'http' | 'sse';
  mcpCommand?: string;
  mcpArgs?: string;
  mcpCwd?: string;
  mcpEnv?: { key?: string; value?: string }[];
  mcpUrl?: string;
  mcpHeaders?: { key?: string; value?: string }[];
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
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const kind = Form.useWatch('kind', form) || initialKind;
  const mcpTransport = Form.useWatch('mcpTransport', form) || 'stdio';
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

  // 切换安装源后，剔除已经不在声明目标里的选择，避免用户以为还能装到不兼容宿主。
  useEffect(() => {
    const allowed = new Set(owners.map((option) => option.value));
    const current: string[] = form.getFieldValue('owners') || [];
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
    form.setFieldsValue({ source: '' });
  };

  useEffect(() => {
    if (!open) return;
    setCandidate(undefined);
    setSourceMode('path');
    setSourceUrl('');
    setUpload(null);
    form.setFieldsValue({
      kind: initialKind,
      owners: [],
      source: '',
      name: undefined,
      link: false,
      mcpTransport: 'stdio',
      mcpCommand: '',
      mcpArgs: '',
      mcpCwd: '',
      mcpEnv: [],
      mcpUrl: '',
      mcpHeaders: []
    });
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
      message.warning('所选文件夹没有可导入的文件');
      return;
    }
    setImporting(true);
    try {
      const result = await toolkitAPI.uploadNativeResourceSource(kind, entries);
      setUpload(result);
      form.setFieldsValue({ source: '' });
      message.success(`已导入 ${result.files} 个文件（${formatBytes(result.bytes)}）`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '文件夹导入失败');
    } finally {
      setImporting(false);
    }
  };

  const importUrl = async () => {
    const value = sourceUrl.trim();
    if (!value) {
      message.warning('请填写安装源 URL');
      return;
    }
    setImporting(true);
    try {
      const result = await toolkitAPI.importNativeResourceSourceUrl(kind, value);
      setUpload(result);
      form.setFieldsValue({ source: '' });
      message.success(`已导入 ${result.files} 个文件（${formatBytes(result.bytes)}）`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'URL 导入失败');
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

  const submit = async () => {
    const values = await form.validateFields();
    const selectedKind = values.kind;
    const mcpKind = selectedKind === 'mcp';
    const mcpTransportValue = values.mcpTransport || 'stdio';
    const remoteMCP = mcpKind && mcpTransportValue !== 'stdio';
    const source = values.source?.trim() || '';
    let sourcePayload: Record<string, unknown> = {};
    let mcpPayload: Record<string, unknown> = {};
    if (mcpKind) {
      if (remoteMCP) {
        const url = values.mcpUrl?.trim() || '';
        if (!url) {
          message.warning('请填写 MCP URL');
          return;
        }
        const headerPayload: Record<string, string> = {};
        for (const entry of values.mcpHeaders || []) {
          const key = entry?.key?.trim() || '';
          if (!key) continue;
          if (!/^[A-Za-z0-9-]+$/.test(key)) {
            message.error(`HTTP Header 名称不合法：${key}`);
            return;
          }
          headerPayload[key] = entry.value ?? '';
        }
        mcpPayload = {
          id: values.name?.trim(),
          transport: mcpTransportValue,
          url,
          ...(Object.keys(headerPayload).length ? { headers: headerPayload } : {})
        };
      } else {
        const command = values.mcpCommand?.trim() || '';
        if (!command) {
          message.warning('请填写 MCP 启动命令');
          return;
        }
        const commandArgs = (values.mcpArgs || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const cwd = values.mcpCwd?.trim() || '';
        const envPayload: Record<string, string> = {};
        for (const entry of values.mcpEnv || []) {
          const key = entry?.key?.trim() || '';
          if (!key) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            message.error(`环境变量名不合法：${key}`);
            return;
          }
          envPayload[key] = entry.value ?? '';
        }
        mcpPayload = {
          id: values.name?.trim(),
          transport: 'stdio',
          command,
          ...(commandArgs.length ? { commandArgs } : {}),
          ...(cwd ? { cwd } : {}),
          ...(Object.keys(envPayload).length ? { env: envPayload } : {})
        };
      }
    } else {
      if (sourceMode === 'path' && !source) {
        message.warning('请填写安装源路径');
        return;
      }
      if (sourceMode !== 'path' && !upload) {
        message.warning(sourceMode === 'folder' ? '请选择文件夹' : '请先下载 URL 安装源');
        return;
      }
      const wrongPlane = sourceMode === 'path'
        ? inspection?.plane === 'capability'
        : upload?.plane === 'capability';
      if (wrongPlane) {
        message.error('这是 AIH 能力插件（capability），请使用 aih plugin install；当前页只安装 Harness 原生插件');
        return;
      }
      sourcePayload = sourceMode === 'path' ? { source } : { uploadId: upload?.uploadId };
    }
    const targets = values.owners;
    setSubmitting(true);
    try {
      const results = await Promise.allSettled(targets.map((owner) => toolkitAPI.operateNativeResource({
        kind: selectedKind,
        action: 'install',
        ...(mcpKind ? mcpPayload : sourcePayload),
        ...(selectedKind === 'skill' && values.link ? { link: true } : {}),
        ...ownerPayload(owner)
      })));
      const failed = results
        .map((result, index) => ({ result, owner: targets[index] }))
        .filter((item) => item.result.status === 'rejected');
      const succeeded = targets.length - failed.length;
      if (succeeded > 0) onInstalled(selectedKind);
      const sourceLabel = mcpKind
        ? (remoteMCP ? values.mcpUrl?.trim() || 'MCP' : values.mcpCommand?.trim() || 'MCP')
        : sourceMode === 'path' ? source : upload?.name || '安装源';
      if (!failed.length) {
        message.success(`${KIND_LABELS[selectedKind]} ${sourceLabel} 已安装到 ${targets.length} 个目标`);
        onClose();
        return;
      }
      const first = failed[0];
      const reason = first.result.status === 'rejected' && first.result.reason instanceof Error
        ? first.result.reason.message
        : '安装失败';
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
      width={640}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="kind" label="资源类型" rules={[{ required: true, message: '请选择资源类型' }]}>
          <Select
            options={RESOURCE_KINDS.map((item) => ({ value: item, label: KIND_LABELS[item] }))}
            onChange={() => {
              resetSource('path');
              form.setFieldsValue({
                owners: [],
                name: undefined,
                mcpTransport: 'stdio',
                mcpCommand: '',
                mcpArgs: '',
                mcpCwd: '',
                mcpEnv: [],
                mcpUrl: '',
                mcpHeaders: []
              });
            }}
          />
        </Form.Item>
        {kind === 'skill' ? (
          <Form.Item
            name="link"
            valuePropName="checked"
            extra={
              <Typography.Text type="secondary">
                使用链接投影：多个 Provider 共享同一份托管快照，不再各复制一份；
                Windows 使用 junction。禁用时只移除链接，快照保留。
              </Typography.Text>
            }
          >
            <Checkbox>使用链接投影（节省空间）</Checkbox>
          </Form.Item>
        ) : null}
        {kind === 'mcp' ? (
          <>
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
            <Form.Item name="mcpTransport" label="传输协议">
              <Segmented
                block
                options={[
                  { value: 'stdio', label: 'stdio' },
                  { value: 'http', label: 'HTTP' },
                  { value: 'sse', label: 'SSE' }
                ]}
              />
            </Form.Item>
            {mcpTransport === 'stdio' ? (
              <>
                <Form.Item
                  name="mcpCommand"
                  label="启动命令"
                  rules={[{ required: true, message: '请填写启动命令' }]}
                  extra={<Typography.Text type="secondary">例如 npx、node、uvx；参数在下方逐行填写。</Typography.Text>}
                >
                  <Input placeholder="npx" autoComplete="off" />
                </Form.Item>
                <Form.Item
                  name="mcpArgs"
                  label="命令参数"
                  extra={<Typography.Text type="secondary">每行一个参数，按原样传给命令。</Typography.Text>}
                >
                  <Input.TextArea rows={3} placeholder={'-y\n@modelcontextprotocol/server-github'} />
                </Form.Item>
                <Form.Item
                  name="mcpCwd"
                  label="工作目录（可选）"
                  extra={<Typography.Text type="secondary">必须是绝对路径；部分 Provider 不支持 cwd。</Typography.Text>}
                >
                  <Input placeholder="/path/to/project" autoComplete="off" />
                </Form.Item>
                <Form.Item label="环境变量（可选）">
                  <Form.List name="mcpEnv">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map(({ key, name, ...restField }) => (
                          <Space key={key} align="baseline" style={{ display: 'flex' }}>
                            <Form.Item
                              {...restField}
                              name={[name, 'key']}
                              rules={[{ pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, message: '仅支持字母、数字、下划线' }]}
                              style={{ marginBottom: 8 }}
                            >
                              <Input placeholder="KEY" autoComplete="off" />
                            </Form.Item>
                            <Form.Item {...restField} name={[name, 'value']} style={{ marginBottom: 8 }}>
                              <Input placeholder="value" autoComplete="off" />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => remove(name)} />
                          </Space>
                        ))}
                        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>
                          添加环境变量
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Form.Item>
              </>
            ) : (
              <>
                <Form.Item
                  name="mcpUrl"
                  label="MCP URL"
                  rules={[{ required: true, message: '请填写 MCP URL' }]}
                  extra={<Typography.Text type="secondary">HTTP 使用 Streamable HTTP；SSE 使用旧版 SSE 端点。URL 必须是 http(s)。</Typography.Text>}
                >
                  <Input placeholder="https://example.com/mcp" autoComplete="off" />
                </Form.Item>
                <Form.Item label="HTTP Headers（可选）">
                  <Form.List name="mcpHeaders">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map(({ key, name, ...restField }) => (
                          <Space key={key} align="baseline" style={{ display: 'flex' }}>
                            <Form.Item
                              {...restField}
                              name={[name, 'key']}
                              rules={[{ pattern: /^[A-Za-z0-9-]+$/, message: '仅支持字母、数字与连字符' }]}
                              style={{ marginBottom: 8 }}
                            >
                              <Input placeholder="Authorization" autoComplete="off" />
                            </Form.Item>
                            <Form.Item {...restField} name={[name, 'value']} style={{ marginBottom: 8 }}>
                              <Input placeholder="Bearer ..." autoComplete="off" />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => remove(name)} />
                          </Space>
                        ))}
                        <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>
                          添加 Header
                        </Button>
                      </>
                    )}
                  </Form.List>
                </Form.Item>
              </>
            )}
          </>
        ) : null}
        {kind === 'mcp' ? null : (
          <>
        <Form.Item label="安装源">
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
        </Form.Item>
        {sourceMode === 'path' ? (
          <>
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
                    setInspection(null);
                    setInspectError('');
                    form.setFieldsValue({ source: value || '' });
                  }}
                />
                {declaredTargets?.length ? (
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                    声明目标：{declaredTargets.join(' / ')}；安装目标已按声明过滤。
                  </Typography.Text>
                ) : null}
              </Form.Item>
            ) : null}
            <Form.Item
              name="source"
              label="安装源路径"
              preserve={false}
              rules={[{ required: true, message: '请填写安装源路径' }]}
              extra={
                <Typography.Text type="secondary">
                  路径相对安装包根目录；也可以选择文件夹或从 URL 导入。
                  {kind === 'plugin' ? ' 支持 npm:包名@版本（DSH / OpenCode 社区插件，由目标 harness 自己安装依赖）。' : ''}
                  {kind === 'skill' ? ' Skill 目录需包含 SKILL.md。' : ''}
                  {kind === 'plugin' ? ' 插件目录需包含 package.json 与 agentPlugin 声明。' : ''}
                </Typography.Text>
              }
            >
              <Input
                placeholder={kind === 'skill'
                  ? 'assets/provider-skills/aih-collab'
                  : kind === 'plugin' ? 'npm:dsh-context@0.87.1 或 assets/native-plugins/<plugin>' : 'assets/native-plugins/<plugin>'}
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
                    loading={inspecting}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void inspectPath()}
                  >
                    预检
                  </Button>
                )}
              />
              {inspectError ? (
                <Typography.Text type="danger" style={{ display: 'block', marginTop: 4 }}>
                  预检失败：{inspectError}
                </Typography.Text>
              ) : inspection?.plane === 'capability' ? (
                <Typography.Text type="danger" style={{ display: 'block', marginTop: 4 }}>
                  这是 AIH 能力插件（capability，{inspection.id || '未命名'}），不是 Harness 原生插件；请使用 aih plugin install。
                </Typography.Text>
              ) : inspection ? (
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                  预检：{inspection.id || '脚本'}
                  {inspection.version ? ` ${inspection.version}` : ''}
                  {inspection.targets?.length
                    ? ` · 兼容目标 ${inspection.targets.join(' / ')}`
                    : ' · 未声明目标限制'}
                </Typography.Text>
              ) : null}
            </Form.Item>
          </>
        ) : null}
        {sourceMode === 'folder' ? (
          <Form.Item
            label="本地文件夹"
            extra={<Typography.Text type="secondary">选择包含 package.json / SKILL.md 的目录；单包最多 4MB、256 个文件。</Typography.Text>}
          >
            <Space wrap>
              <Button
                icon={<FolderOpenOutlined />}
                loading={importing}
                onClick={() => folderInputRef.current?.click()}
              >选择文件夹</Button>
              {upload ? (
                <Typography.Text type="secondary">
                  已导入：{upload.name || '文件夹'} · {upload.files} 个文件 · {formatBytes(upload.bytes)}
                  {upload.targets?.length ? ` · 兼容目标 ${upload.targets.join(' / ')}` : ''}
                  {upload.plane === 'capability' ? ' · AIH 能力插件（当前页不可安装）' : ''}
                </Typography.Text>
              ) : null}
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
          </Form.Item>
        ) : null}
        {sourceMode === 'url' ? (
          <Form.Item
            label="安装源 URL"
            extra={<Typography.Text type="secondary">支持 http(s) 直链；zip / tar.gz / tar 会自动解包，单文件直接作为源。</Typography.Text>}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={sourceUrl}
                placeholder="https://example.com/plugin.zip"
                autoComplete="off"
                onChange={(event) => setSourceUrl(event.target.value)}
              />
              <Button
                icon={<LinkOutlined />}
                loading={importing}
                onClick={() => void importUrl()}
              >下载</Button>
            </Space.Compact>
            {upload ? (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                已导入：{upload.name} · {upload.files} 个文件 · {formatBytes(upload.bytes)}
                {upload.targets?.length ? ` · 兼容目标 ${upload.targets.join(' / ')}` : ''}
                {upload.plane === 'capability' ? ' · AIH 能力插件（当前页不可安装）' : ''}
              </Typography.Text>
            ) : null}
          </Form.Item>
        ) : null}
          </>
        )}
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
