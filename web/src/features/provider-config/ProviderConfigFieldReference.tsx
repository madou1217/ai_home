import { useEffect, useMemo, useState } from 'react';
import { Empty, Input, Tag } from 'antd';
import { CodeOutlined, ExportOutlined, SearchOutlined, WarningOutlined } from '@ant-design/icons';
import type {
  ProviderConfigCliInfo,
  ProviderConfigSchema,
  ProviderConfigSchemaVersionStatus
} from '@/types';
import {
  buildProviderConfigReferenceRows,
  countReferenceIssues,
  countUnrecordedKeys,
  filterReferenceRows,
  REFERENCE_ISSUE_LABELS,
  REFERENCE_TYPE_LABELS
} from './provider-config-reference';

interface Props {
  schema: ProviderConfigSchema | null;
  content: string;
  format: string;
  cli: ProviderConfigCliInfo | null;
  schemaVersion?: ProviderConfigSchemaVersionStatus | null;
}

// 「参数解读」：左侧是这份配置文件里真实出现的键，右侧是选中键的说明与等价命令行用法。
// 选中项用强调色高亮，问题项（未收录 / 已弃用 / 当前版本不支持）用告警色高亮，两者互不覆盖。
export default function ProviderConfigFieldReference({
  schema,
  content,
  format,
  cli,
  schemaVersion
}: Props) {
  const cliVersion = cli?.version || '';
  const [keyword, setKeyword] = useState('');
  const [selectedPath, setSelectedPath] = useState('');

  const rows = useMemo(
    () => buildProviderConfigReferenceRows(schema, content, format, cliVersion),
    [content, format, schema, cliVersion]
  );
  const filtered = useMemo(() => filterReferenceRows(rows, keyword), [rows, keyword]);
  const problemCount = useMemo(() => countReferenceIssues(rows), [rows]);
  const unrecordedCount = useMemo(() => countUnrecordedKeys(rows), [rows]);

  useEffect(() => {
    if (selectedPath && rows.some((row) => row.path === selectedPath)) return;
    const next = rows[0] || null;
    setSelectedPath(next ? next.path : '');
  }, [rows, selectedPath]);

  const activeRow = filtered.find((row) => row.path === selectedPath) || filtered[0] || null;
  const field = activeRow?.field || null;
  const sourceUrl = schema?.sourceUrl || schema?.docsUrl || '';

  return (
    <div className="pc-ref">
      <div className="pc-ref-list" aria-label="配置文件里出现的字段">
        <div className="pc-ref-list-head">
          <div>
            <div className="pc-kicker">CONFIG FIELD REFERENCE</div>
            <strong>参数解读</strong>
          </div>
          <span className="pc-ref-count">
            {rows.length} 个键
            {problemCount > 0 ? ` · ${problemCount} 个待处理` : ''}
            {unrecordedCount > 0 ? ` · ${unrecordedCount} 个未收录` : ''}
          </span>
        </div>
        <Input
          allowClear
          size="small"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          prefix={<SearchOutlined />}
          placeholder="搜索这份文件里的键"
          aria-label="搜索配置文件里出现的键"
        />
        {filtered.length ? (
          <div className="pc-ref-rows" role="list">
            {filtered.map((row) => (
              <button
                key={row.path}
                type="button"
                role="listitem"
                className="pc-ref-row"
                data-active={row.path === selectedPath || undefined}
                data-issue={row.issue === 'none' ? undefined : row.issue}
                onClick={() => setSelectedPath(row.path)}
              >
                <span className="pc-ref-row-path">{row.path}</span>
                <span className="pc-ref-row-meta">
                  {row.issue === 'none' ? (
                    <span className="pc-ref-row-kind">
                      {row.field ? REFERENCE_TYPE_LABELS[row.field.type] || row.field.type : ''}
                    </span>
                  ) : (
                    <span className="pc-ref-row-issue">
                      <WarningOutlined /> {REFERENCE_ISSUE_LABELS[row.issue as 'unknown' | 'deprecated' | 'unsupported']}
                    </span>
                  )}
                  <span className="pc-ref-row-line">第 {row.line} 行</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="pc-ref-empty">
            {rows.length ? '没有匹配的键。' : '这份配置文件里还没有任何键。'}
          </div>
        )}
      </div>

      <div className="pc-ref-detail">
        {activeRow ? (
          <div className="pc-field-card" data-reference-active="true">
            <div className="pc-field-path" title={activeRow.path}>{activeRow.path}</div>
            <div className="pc-field-meta">
              {field ? (
                <>
                  <Tag color="geekblue">
                    {REFERENCE_TYPE_LABELS[field.type] || field.typeLabel || field.type || '未知'}
                  </Tag>
                  {field.secret && <Tag color="red">敏感</Tag>}
                  {field.scope && <Tag>{field.scope}</Tag>}
                  {field.topic && <Tag>{field.topic}</Tag>}
                </>
              ) : (
                <Tag color="orange">未收录</Tag>
              )}
              <Tag>第 {activeRow.line} 行</Tag>
            </div>

            <p className="pc-field-description">
              {field?.description || '离线快照没有这个键的说明。'}
            </p>

            {activeRow.issue !== 'none' && (
              <div
                className="pc-inspector-note"
                data-tone={
                  activeRow.issue === 'deprecated'
                    ? 'warning'
                    : activeRow.issue === 'unsupported'
                      ? 'danger'
                      : 'muted'
                }
              >
                <WarningOutlined />
                <span>{activeRow.messages.join(' ')}</span>
              </div>
            )}

            {field?.options && field.options.length > 0 && (
              <div className="pc-inspector-section">
                <div className="pc-inspector-label">可选值</div>
                <div className="pc-option-list">
                  {field.options.map((option) => (
                    <span key={String(option)} className="pc-ref-option">{String(option)}</span>
                  ))}
                </div>
              </div>
            )}

            {field?.default !== undefined && field.default !== '' && (
              <div className="pc-inspector-section">
                <div className="pc-inspector-label">默认值</div>
                <code className="pc-inspector-code">{JSON.stringify(field.default)}</code>
              </div>
            )}

            {(field?.since || field?.removedIn) && (
              <div className="pc-inspector-section">
                <div className="pc-inspector-label">版本边界</div>
                <div className="pc-inspector-inline">
                  {field.since && <span>自 {field.since} 起</span>}
                  {field.removedIn && <span>{field.removedIn} 起移除</span>}
                </div>
              </div>
            )}

            {field?.cliSample && (
              <div className="pc-inspector-section">
                <div className="pc-inspector-label">命令行用法</div>
                <div className="pc-ref-cli">
                  <CodeOutlined />
                  <code>{field.cliSample}</code>
                </div>
                <span className="pc-ref-cli-hint">
                  等价于在配置文件里设置 {field.path}；旗标已在本机 CLI 的 --help 中确认。
                </span>
              </div>
            )}

            {sourceUrl && (
              <a className="pc-inspector-source" href={sourceUrl} target="_blank" rel="noreferrer">
                <ExportOutlined /> 查看官方文档
              </a>
            )}
          </div>
        ) : schema ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧的键查看说明。" />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个文件没有可用的离线字段说明。" />
        )}

        <div className="pc-ref-foot">
          <span>
            {schema ? `字段说明来自 ${schema.source || '离线官方快照'}，校对 CLI ${schema.verifiedCliVersion || '未标注'}` : ''}
            {schemaVersion?.mismatch ? `；${schemaVersion.message}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
