import { useMemo, useState } from 'react';
import { Empty, Input, Tag, Tooltip } from 'antd';
import {
  BuildOutlined,
  CheckCircleOutlined,
  ExportOutlined,
  SearchOutlined,
  WarningOutlined
} from '@ant-design/icons';
import type {
  ProviderConfigCliInfo,
  ProviderConfigSchema,
  ProviderConfigSchemaField
} from '@/types';
import type { ProviderConfigOutlineEntry } from './provider-config-outline';
import { describeFieldCompatibility } from './provider-config-outline';

interface Props {
  schema: ProviderConfigSchema | null;
  field: ProviderConfigSchemaField | null;
  entry: ProviderConfigOutlineEntry | null;
  cli: ProviderConfigCliInfo | null;
  cliVersion: string;
  onApplyOption?: (option: string | number | boolean) => void;
  onSelectField: (field: ProviderConfigSchemaField) => void;
}

const TYPE_LABELS: Record<string, string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔',
  array: '数组',
  object: '对象',
  enum: '枚举'
};

function FieldCompatibility({ field, cliVersion }: { field: ProviderConfigSchemaField; cliVersion: string }) {
  const compatibility = describeFieldCompatibility(field, cliVersion);
  if (!compatibility || compatibility.state === 'ok') return null;
  const unsupported = compatibility.state === 'unsupported';
  return (
    <div className="pc-inspector-note" data-tone={unsupported ? 'danger' : 'warning'}>
      {unsupported ? <WarningOutlined /> : <WarningOutlined />}
      <span>{compatibility.messages.join(' ')}</span>
    </div>
  );
}

function OptionChips({
  field,
  entry,
  onApplyOption
}: {
  field: ProviderConfigSchemaField;
  entry: ProviderConfigOutlineEntry | null;
  onApplyOption?: (option: string | number | boolean) => void;
}) {
  if (!field.options || !field.options.length) return null;
  return (
    <div className="pc-inspector-section">
      <div className="pc-inspector-label">可选值</div>
      <div className="pc-option-list">
        {field.options.map((option) => (
          <Tooltip
            key={String(option)}
            title={entry ? '写入该键所在行（保存后生效）' : '先在编辑器中把光标放到该键上'}
          >
            <button
              type="button"
              className="pc-option-chip"
              disabled={!entry || !onApplyOption}
              onClick={() => onApplyOption?.(option)}
            >
              {String(option)}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

export default function ProviderConfigFieldInspector({
  schema,
  field,
  entry,
  cli,
  cliVersion,
  onApplyOption,
  onSelectField
}: Props) {
  const [search, setSearch] = useState('');
  const catalog = useMemo(() => {
    const fields = schema?.fields || [];
    const keyword = search.trim().toLowerCase();
    if (!keyword) return fields.slice(0, 60);
    return fields
      .filter((item) => `${item.path} ${item.description || ''}`.toLowerCase().includes(keyword))
      .slice(0, 60);
  }, [schema, search]);

  const sourceUrl = field?.sourceUrl || schema?.sourceUrl || schema?.docsUrl || '';

  return (
    <div className="pc-inspector">
      <div className="pc-inspector-head">
        <div>
          <div className="pc-kicker">FIELD REFERENCE</div>
          <strong>字段解读</strong>
        </div>
        {schema && <Tag className="pc-tag">{schema.fieldCount} 个字段</Tag>}
      </div>

      {field ? (
        <div className="pc-field-card">
          <div className="pc-field-path" title={entry?.path || field.path}>
            {entry?.path || field.path}
          </div>
          <div className="pc-field-meta">
            <Tag color="geekblue">{TYPE_LABELS[field.type] || field.typeLabel || field.type || '未知'}</Tag>
            {field.secret && <Tag color="red">敏感</Tag>}
            {field.deprecated && <Tag color="orange">已弃用</Tag>}
            {field.scope && <Tag>{field.scope}</Tag>}
            {field.topic && <Tag>{field.topic}</Tag>}
          </div>
          <p className="pc-field-description">{field.description || '离线快照未收录该键的说明。'}</p>
          <FieldCompatibility field={field} cliVersion={cliVersion} />
          <OptionChips field={field} entry={entry} onApplyOption={onApplyOption} />
          {field.default !== undefined && field.default !== '' && (
            <div className="pc-inspector-section">
              <div className="pc-inspector-label">默认值</div>
              <code className="pc-inspector-code">{JSON.stringify(field.default)}</code>
            </div>
          )}
          {(field.since || field.removedIn) && (
            <div className="pc-inspector-section">
              <div className="pc-inspector-label">版本边界</div>
              <div className="pc-inspector-inline">
                {field.since && <span>自 {field.since} 起</span>}
                {field.removedIn && <span>{field.removedIn} 起移除</span>}
              </div>
            </div>
          )}
          {sourceUrl && (
            <a className="pc-inspector-source" href={sourceUrl} target="_blank" rel="noreferrer">
              <ExportOutlined /> 查看官方文档
            </a>
          )}
        </div>
      ) : (
        <div className="pc-field-card pc-field-card--empty">
          {entry ? (
            <>
              <div className="pc-field-path">{entry.path}</div>
              <p className="pc-field-description">
                离线字段快照没有收录这个键。它仍会按原样保存；如果是新版本新增的参数，
                请以官方文档为准，避免凭猜测写入。
              </p>
              {sourceUrl && (
                <a className="pc-inspector-source" href={sourceUrl} target="_blank" rel="noreferrer">
                  <ExportOutlined /> 查看官方文档
                </a>
              )}
            </>
          ) : schema ? (
            <>
              <div className="pc-field-path">{schema.title}</div>
              <p className="pc-field-description">
                把光标放到编辑器里的某个键上，或在下方搜索字段名。未收录的键会回退到父级说明，
                不会凭空生成参数。
              </p>
              <div className="pc-inspector-inline">
                <span>校对版本 {schema.verifiedCliVersion || '未标注'}</span>
                <span>{cli?.installed ? `当前 CLI ${cli.version || '版本未知'}` : '当前 CLI 未安装'}</span>
              </div>
              {schema.sourceUrl && (
                <a className="pc-inspector-source" href={schema.sourceUrl} target="_blank" rel="noreferrer">
                  <ExportOutlined /> {schema.source || '官方文档'}
                </a>
              )}
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该文件还没有可用的离线字段说明，可直接编辑并保存。"
            />
          )}
        </div>
      )}

      {schema && (
        <div className="pc-inspector-catalog">
          <Input
            allowClear
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            prefix={<SearchOutlined />}
            placeholder="搜索字段或说明"
            aria-label="搜索字段说明"
          />
          {catalog.length ? (
            <div className="pc-catalog-list" role="list">
              {catalog.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="pc-catalog-item"
                  data-active={field?.path === item.path || undefined}
                  onClick={() => onSelectField(item)}
                >
                  <span className="pc-catalog-path">{item.path}</span>
                  <span className="pc-catalog-desc">{item.description}</span>
                  {item.secret && <CheckCircleOutlined className="pc-catalog-flag" aria-label="敏感字段" />}
                </button>
              ))}
            </div>
          ) : (
            <div className="pc-inspector-hint">没有匹配的字段。未收录的键仍可编辑与保存。</div>
          )}
        </div>
      )}

      <div className="pc-inspector-foot">
        <BuildOutlined />
        <span>字段说明来自离线官方快照，不随请求访问网络；版本不一致时会明确提示。</span>
      </div>
    </div>
  );
}
