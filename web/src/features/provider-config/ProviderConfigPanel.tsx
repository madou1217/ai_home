import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawer, Grid, Input, Modal, Spin, Tag, Tooltip, message } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExportOutlined,
  FileTextOutlined,
  HistoryOutlined,
  KeyOutlined,
  PlusOutlined,
  ReadOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  WarningOutlined
} from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import Button from '@/components/ui/AppButton';
import ConfigCodeEditor from '@/components/toolkit/config-editor/ConfigCodeEditor';
import { providerConfigAPI } from '@/services/api';
import type {
  ProviderConfigDetailResponse,
  ProviderConfigFileSummary,
  ProviderConfigProvider,
  ProviderConfigSchemaField,
  ProviderConfigValidationResponse
} from '@/types';
import ProviderConfigExportModal from './ProviderConfigExportModal';
import ProviderConfigFieldInspector from './ProviderConfigFieldInspector';
import ProviderConfigHistoryDrawer from './ProviderConfigHistoryDrawer';
import {
  applyProviderConfigOption,
  buildProviderConfigOutline,
  findProviderConfigSchemaField,
  resolveProviderConfigOutlineEntry
} from './provider-config-outline';
import './provider-config.css';

function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message || (error instanceof Error ? error.message : '请求失败');
}

function isConflict(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}

function fileStatus(file: ProviderConfigFileSummary) {
  if (!file.exists) return { label: '未创建', tone: 'muted' };
  if (file.sensitive) return { label: '含凭据', tone: 'danger' };
  return { label: '已配置', tone: 'ok' };
}

function configuredCount(provider: ProviderConfigProvider): number {
  return provider.files.filter((file) => file.exists).length;
}

function firstFileId(provider: ProviderConfigProvider | null): string {
  if (!provider || !provider.files.length) return '';
  return (provider.files.find((file) => file.exists) || provider.files[0]).id;
}

export default function ProviderConfigPanel() {
  const screens = Grid.useBreakpoint();
  const compact = !screens.lg;
  const [providers, setProviders] = useState<ProviderConfigProvider[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [activeProvider, setActiveProvider] = useState('');
  const [activeFileId, setActiveFileId] = useState('');
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState<ProviderConfigDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const [content, setContent] = useState('');
  const [loadedContent, setLoadedContent] = useState('');
  const [revision, setRevision] = useState('');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ProviderConfigValidationResponse | null>(null);

  const [cursorLine, setCursorLine] = useState(1);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [manualField, setManualField] = useState<ProviderConfigSchemaField | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const [viewportHeight, setViewportHeight] = useState(
    typeof window === 'undefined' ? 900 : window.innerHeight
  );

  const dirty = content !== loadedContent;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadProviders = useCallback(async (options: { keepSelection?: boolean } = {}) => {
    const result = await providerConfigAPI.list();
    setProviders(result.providers || []);
    if (!options.keepSelection) {
      const preferred = result.providers.find((provider) => configuredCount(provider) > 0)
        || result.providers.find((provider) => provider.id === 'codex')
        || result.providers[0]
        || null;
      if (preferred) {
        setActiveProvider(preferred.id);
        setActiveFileId(firstFileId(preferred));
      }
    }
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError('');
    loadProviders()
      .catch((error) => {
        if (active) setListError(describeError(error));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadProviders]);

  useEffect(() => {
    if (!activeProvider || !activeFileId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError('');
    providerConfigAPI.get(activeProvider, activeFileId)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setContent(result.content || '');
        setLoadedContent(result.content || '');
        setRevision(result.revision || '');
        setValidation(null);
        setCursorLine(1);
        setHoverLine(null);
        setManualField(null);
      })
      .catch((error) => {
        if (active) {
          setDetail(null);
          setDetailError(describeError(error));
        }
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeFileId, activeProvider, reloadToken]);

  // 语法校验：只在有未保存修改时请求服务端（编辑器改动后 800ms 防抖）。
  useEffect(() => {
    if (!detail || !dirty || !activeProvider || !activeFileId) {
      if (!dirty) setValidation(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setValidating(true);
      providerConfigAPI.validate(activeProvider, activeFileId, content)
        .then((result) => {
          if (active) setValidation(result);
        })
        .catch((error) => {
          if (active) {
            setValidation({
              ok: false,
              valid: false,
              errors: [{ message: describeError(error), line: 0, column: 0 }]
            });
          }
        })
        .finally(() => {
          if (active) setValidating(false);
        });
    }, 800);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeFileId, activeProvider, content, detail, dirty]);

  const provider = useMemo(
    () => providers.find((item) => item.id === activeProvider) || null,
    [activeProvider, providers]
  );

  const file = detail?.file || provider?.files.find((item) => item.id === activeFileId) || null;

  const outline = useMemo(
    () => buildProviderConfigOutline(content, detail?.file.format || file?.format || 'text'),
    [content, detail?.file.format, file?.format]
  );

  const activeLine = hoverLine || cursorLine;
  const outlineEntry = useMemo(
    () => resolveProviderConfigOutlineEntry(outline, activeLine),
    [activeLine, outline]
  );

  const schemaField = useMemo(
    () => manualField || findProviderConfigSchemaField(detail?.schema?.fields, outlineEntry?.path || ''),
    [detail?.schema?.fields, manualField, outlineEntry?.path]
  );

  const inspectorEntry = useMemo(() => {
    if (!schemaField || !outlineEntry) return null;
    const sameLine = outlineEntry.path === schemaField.path;
    const insideField = outlineEntry.path.startsWith(`${schemaField.path}.`);
    const fieldInsideEntry = schemaField.path.startsWith(`${outlineEntry.path}.`);
    return sameLine || insideField || fieldInsideEntry ? outlineEntry : null;
  }, [outlineEntry, schemaField]);

  useEffect(() => {
    setManualField(null);
  }, [cursorLine]);

  const filteredProviders = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return providers;
    return providers.filter((item) => {
      const haystack = [
        item.id,
        item.label,
        ...item.files.map((entry) => `${entry.label} ${entry.displayPath} ${entry.description}`)
      ].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
  }, [providers, search]);

  const confirmDiscard = useCallback(() => new Promise<boolean>((resolve) => {
    if (!dirtyRef.current) {
      resolve(true);
      return;
    }
    Modal.confirm({
      title: '放弃未保存的修改？',
      content: '切换文件会丢弃当前编辑器里的改动，已保存的版本和版本历史不受影响。',
      okText: '放弃修改',
      cancelText: '继续编辑',
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    });
  }), []);

  const selectProvider = async (providerId: string) => {
    if (providerId === activeProvider) return;
    if (!(await confirmDiscard())) return;
    const next = providers.find((item) => item.id === providerId) || null;
    setActiveProvider(providerId);
    setActiveFileId(firstFileId(next));
  };

  const selectFile = async (fileId: string) => {
    if (fileId === activeFileId) return;
    if (!(await confirmDiscard())) return;
    setActiveFileId(fileId);
  };

  const reload = async () => {
    if (!(await confirmDiscard())) return;
    setReloadToken((value) => value + 1);
    try {
      const result = await loadProviders({ keepSelection: true });
      if (!result.providers.some((item) => item.id === activeProvider)) {
        const preferred = result.providers.find((item) => configuredCount(item) > 0) || result.providers[0] || null;
        setActiveProvider(preferred?.id || '');
        setActiveFileId(firstFileId(preferred));
      }
    } catch (error) {
      message.error(describeError(error));
    }
  };

  const save = useCallback(async () => {
    if (!detail || saving || !activeProvider || !activeFileId) return;
    const value = content;
    setSaving(true);
    try {
      const result = await providerConfigAPI.save(activeProvider, activeFileId, {
        content: value,
        revision
      });
      setRevision(result.revision);
      setLoadedContent(value);
      setDetail((current) => current ? {
        ...current,
        revision: result.revision,
        content: value,
        size: result.size,
        file: {
          ...current.file,
          exists: true,
          canCreate: false,
          size: result.size,
          modifiedAt: result.savedAt
        },
        historyCount: current.historyCount + (result.historyEntry ? 1 : 0)
      } : current);
      if (result.changed) message.success('配置已保存');
      else message.info('内容没有变化');
      void loadProviders({ keepSelection: true }).catch(() => {});
    } catch (error) {
      if (isConflict(error)) {
        message.error('文件在编辑期间被其他进程修改。请重新加载后再保存，当前草稿仍在编辑器里。', 8);
      } else {
        message.error(describeError(error), 6);
      }
    } finally {
      setSaving(false);
    }
  }, [activeFileId, activeProvider, content, detail, loadProviders, revision, saving]);

  const applyOption = (option: string | number | boolean) => {
    if (!outlineEntry || !detail) return;
    const result = applyProviderConfigOption(content, outlineEntry, option, detail.file.format);
    if (!result.applied) {
      message.warning('没有在该行找到可替换的值，请手动修改');
      return;
    }
    setContent(result.content);
    message.success(`已写入 ${String(option)}，保存后生效`);
  };

  const schemaWarnings = detail?.schema?.compatibilityWarnings || [];
  const validationErrors = validation && !validation.valid ? validation.errors : [];
  const editorHeight = Math.max(compact ? 320 : 380, Math.min(640, viewportHeight - (compact ? 500 : 430)));
  const status = file ? fileStatus(file) : null;

  const inspector = (
    <ProviderConfigFieldInspector
      schema={detail?.schema || null}
      field={schemaField}
      entry={inspectorEntry}
      cli={detail?.cli || null}
      cliVersion={detail?.cli?.version || ''}
      onApplyOption={applyOption}
      onSelectField={(field) => {
        setManualField(field);
        if (compact) setInspectorOpen(true);
      }}
    />
  );

  return (
    <section className="toolkit-page toolkit-domain-panel pc-panel" aria-labelledby="toolkit-provider-config-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">PROVIDER CONFIG WORKBENCH</div>
          <h2 id="toolkit-provider-config-title">Provider 配置</h2>
          <p>
            浏览每个 CLI 的宿主全局配置文件：右侧字段解读、语法校验、版本历史与脱敏导出都在同一个工作台里，
            不需要自己去找文件路径。
          </p>
        </div>
        <div className="toolkit-header-actions">
          {compact && (
            <Button icon={<ReadOutlined />} onClick={() => setInspectorOpen(true)}>
              字段解读
            </Button>
          )}
          <Button icon={<ReloadOutlined />} loading={listLoading && !providers.length} onClick={() => void reload()}>
            重新读取
          </Button>
        </div>
      </header>

      {listError && <div className="pc-inline-error" role="alert">{listError}</div>}

      {listLoading && !providers.length ? (
        <div className="pc-loading"><Spin size="large" tip="正在读取 Provider 配置文件" /></div>
      ) : (
        <div className="pc-layout" data-compact={compact || undefined}>
          <aside className="pc-provider-rail" aria-label="Provider 列表">
            <Input
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              prefix={<SearchOutlined />}
              placeholder="搜索 Provider / 文件"
              aria-label="搜索 Provider 或配置文件"
            />
            <div className="pc-provider-list">
              {filteredProviders.map((item) => {
                const configured = configuredCount(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="pc-provider-item"
                    data-active={item.id === activeProvider || undefined}
                    aria-pressed={item.id === activeProvider}
                    onClick={() => void selectProvider(item.id)}
                  >
                    <span className="pc-provider-icon" aria-hidden="true">
                      <ProviderIcon provider={item.id} size={22} />
                    </span>
                    <span className="pc-provider-copy">
                      <strong>{item.label}</strong>
                      <small>{item.files.length} 个文件 · {configured ? `${configured} 个已配置` : '尚未创建'}</small>
                    </span>
                    {configured > 0 && <span className="pc-provider-dot" title={`${configured} 个文件已存在`} />}
                  </button>
                );
              })}
              {!filteredProviders.length && <div className="pc-empty-note">没有匹配的 Provider。</div>}
            </div>
          </aside>

          <main className="pc-workbench">
            {provider ? (
              <>
                <div className="pc-provider-head">
                  <div className="pc-provider-title">
                    <ProviderIcon provider={provider.id} size={28} />
                    <div>
                      <strong>{provider.label}</strong>
                      <small>宿主全局配置 · 账号投影不在此处</small>
                    </div>
                  </div>
                  <div className="pc-file-tabs" role="tablist" aria-label={`${provider.label} 配置文件`}>
                    {provider.files.map((entry) => {
                      const entryStatus = fileStatus(entry);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          role="tab"
                          aria-selected={entry.id === activeFileId}
                          className="pc-file-tab"
                          data-active={entry.id === activeFileId || undefined}
                          data-tone={entryStatus.tone}
                          onClick={() => void selectFile(entry.id)}
                        >
                          {entry.exists ? <FileTextOutlined /> : <PlusOutlined />}
                          <span>{entry.label}</span>
                          {entry.sensitive && <KeyOutlined aria-label="包含凭据" />}
                          {!entry.exists && <small>创建</small>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {detailLoading ? (
                  <div className="pc-loading"><Spin tip="正在读取配置文件" /></div>
                ) : detailError ? (
                  <div className="pc-error-state" role="alert">
                    <CloseCircleOutlined />
                    <div>
                      <strong>无法读取该配置文件</strong>
                      <p>{detailError}</p>
                    </div>
                    <Button onClick={() => setReloadToken((value) => value + 1)}>重试</Button>
                  </div>
                ) : detail && file ? (
                  <>
                    <div className="pc-file-status">
                      <div className="pc-file-status-main">
                        <code className="pc-path" title={file.displayPath}>{file.displayPath}</code>
                        <div className="pc-status-tags">
                          <Tag className="pc-tag">{file.format.toUpperCase()}</Tag>
                          {status && <Tag className="pc-tag" color={status.tone === 'ok' ? 'green' : status.tone === 'danger' ? 'red' : 'default'}>{status.label}</Tag>}
                          {file.sensitive && <Tag color="red"><KeyOutlined /> 敏感文件</Tag>}
                          {dirty && <Tag color="orange">未保存</Tag>}
                          {validating && <Tag color="processing">校验中</Tag>}
                          {!validating && validation && validation.valid && dirty && <Tag color="green"><CheckCircleOutlined /> 语法通过</Tag>}
                          {!validating && validationErrors.length > 0 && (
                            <Tag color="red"><CloseCircleOutlined /> {validationErrors.length} 个语法问题</Tag>
                          )}
                          {detail.schema && (
                            <Tag className="pc-tag">
                              {detail.schema.fieldCount} 个字段说明 · 校对 {detail.schema.verifiedCliVersion || '未标注'}
                            </Tag>
                          )}
                          {schemaWarnings.length > 0 && (
                            <Tooltip
                              title={(
                                <div className="pc-tooltip-list">
                                  {schemaWarnings.slice(0, 6).map((warning) => (
                                    <div key={warning.path}>
                                      <code>{warning.path}</code>：{warning.messages.join(' ')}
                                    </div>
                                  ))}
                                </div>
                              )}
                            >
                              <Tag color="orange"><WarningOutlined /> {schemaWarnings.length} 个兼容提示</Tag>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                      <div className="pc-file-actions">
                        <Button
                          size="small"
                          icon={<HistoryOutlined />}
                          onClick={() => setHistoryOpen(true)}
                        >
                          历史
                        </Button>
                        <Button
                          size="small"
                          icon={<ExportOutlined />}
                          onClick={() => setExportOpen(true)}
                        >
                          导出
                        </Button>
                        <Button
                          size="small"
                          type="primary"
                          icon={<SaveOutlined />}
                          loading={saving}
                          disabled={!dirty || validation !== null && !validation.valid}
                          onClick={() => void save()}
                        >
                          保存
                        </Button>
                      </div>
                    </div>

                    {detail.schemaVersion?.mismatch && (
                      <div className="pc-inline-note" data-tone="warning">
                        <WarningOutlined />
                        <span>{detail.schemaVersion.message}</span>
                      </div>
                    )}

                    {!detail.file.writable && (
                      <div className="pc-inline-note" data-tone="warning">
                        <WarningOutlined />
                        <span>当前用户没有写入权限，保存会失败。请先调整文件所属或权限。</span>
                      </div>
                    )}

                    <div className="pc-editor-shell">
                      <ConfigCodeEditor
                        value={content}
                        onChange={setContent}
                        format={detail.file.format}
                        fileName={detail.file.label}
                        ariaLabel={`${provider.label} ${detail.file.label} 配置内容`}
                        height={editorHeight}
                        onSave={saving ? undefined : () => void save()}
                        onCursorLineChange={setCursorLine}
                        onHoverLineChange={setHoverLine}
                      />
                    </div>

                    {validationErrors.length > 0 && (
                      <div className="pc-validation-list" role="status" aria-live="polite">
                        <strong>语法校验未通过，保存按钮已禁用：</strong>
                        <ul>
                          {validationErrors.slice(0, 6).map((error, index) => (
                            <li key={`${error.line}-${error.column}-${index}`}>
                              {error.line ? `第 ${error.line} 行${error.column ? `第 ${error.column} 列` : ''}：` : ''}
                              {error.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <footer className="pc-workbench-foot">
                      <span>需要先创建文件？选择左侧的「未创建」标签页，直接输入内容并保存即可。</span>
                      {detail.schema?.docsUrl && (
                        <a href={detail.schema.docsUrl} target="_blank" rel="noreferrer">
                          <ExportOutlined /> 官方配置文档
                        </a>
                      )}
                    </footer>
                  </>
                ) : null}
              </>
            ) : (
              <div className="pc-empty-note pc-workbench-empty">选择左侧的 Provider 开始。</div>
            )}
          </main>

          {!compact && <aside className="pc-inspector-rail">{inspector}</aside>}
        </div>
      )}

      {compact && (
        <Drawer
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          placement="right"
          width="min(420px, 92vw)"
          title="字段解读"
          destroyOnClose
        >
          {inspector}
        </Drawer>
      )}

      {provider && file && (
        <>
          <ProviderConfigHistoryDrawer
            open={historyOpen}
            provider={provider.id}
            fileId={file.id}
            fileName={file.label}
            onClose={() => setHistoryOpen(false)}
            onRestored={() => {
              setReloadToken((value) => value + 1);
              void loadProviders({ keepSelection: true }).catch(() => {});
            }}
          />
          <ProviderConfigExportModal
            open={exportOpen}
            provider={provider.id}
            fileId={file.id}
            fileName={file.label}
            sensitive={file.sensitive}
            onClose={() => setExportOpen(false)}
          />
        </>
      )}
    </section>
  );
}
