import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { CodeOutlined, FormatPainterOutlined } from '@ant-design/icons';
import { Select, Space, Spin, Tooltip, Typography, message } from 'antd';
import Button from '@/components/ui/AppButton';
import {
  CONFIG_LANGUAGE_OPTIONS,
  canFormatConfigLanguage,
  getConfigLanguageLabel,
  getVirtualConfigExtension,
  resolveConfigLanguage,
  type ConfigLanguage
} from './config-language';
import { formatConfigContent } from './format-config';

const MonacoConfigEditor = lazy(() => import('./MonacoConfigEditor'));
const { Text } = Typography;

interface ConfigCodeEditorProps {
  value: string;
  onChange(value: string): void;
  format?: string;
  fileName?: string;
  ariaLabel: string;
  height?: number;
  detectContent?: boolean;
  onSave?: () => void;
}

function formatError(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : '格式化失败，请检查配置语法';
}

export default function ConfigCodeEditor({
  value,
  onChange,
  format,
  fileName,
  ariaLabel,
  height = 430,
  detectContent = false,
  onSave
}: ConfigCodeEditorProps) {
  const sourceKey = `${format || ''}:${fileName || ''}:${detectContent ? 'detect' : 'fixed'}`;
  const inferredLanguage = useMemo(() => resolveConfigLanguage({
    format,
    fileName,
    content: value,
    detectContent
  }), [detectContent, fileName, format, value]);
  const [language, setLanguage] = useState<ConfigLanguage>(inferredLanguage);
  const [languageSelected, setLanguageSelected] = useState(false);
  const [formatting, setFormatting] = useState(false);
  const [highlightingStatus, setHighlightingStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');

  useEffect(() => {
    setLanguage(inferredLanguage);
    setLanguageSelected(false);
  }, [sourceKey]);

  useEffect(() => {
    if (!languageSelected && detectContent) setLanguage(inferredLanguage);
  }, [detectContent, inferredLanguage, languageSelected]);

  const runFormatter = async () => {
    if (!canFormatConfigLanguage(language)) return;
    setFormatting(true);
    try {
      const formatted = await formatConfigContent(language, value);
      onChange(formatted);
      message.success(`${getConfigLanguageLabel(language)} 已格式化，请确认后保存`);
    } catch (error: unknown) {
      message.error(formatError(error));
    } finally {
      setFormatting(false);
    }
  };

  const virtualName = encodeURIComponent(fileName || `config.${getVirtualConfigExtension(language)}`);
  const virtualPath = `inmemory://aih-toolkit/${virtualName}`;
  const formatSupported = canFormatConfigLanguage(language);

  return (
    <div className="toolkit-code-editor">
      <div className="toolkit-code-editor-toolbar">
        <Space size={8} wrap>
          <CodeOutlined />
          <Text type="secondary">语法</Text>
          <Select
            aria-label="配置语法"
            value={language}
            options={CONFIG_LANGUAGE_OPTIONS.map(({ value: optionValue, label }) => ({
              value: optionValue,
              label
            }))}
            onChange={(nextLanguage: ConfigLanguage) => {
              setLanguage(nextLanguage);
              setLanguageSelected(true);
            }}
            popupMatchSelectWidth={false}
          />
        </Space>
        <Space size={8} wrap>
          {highlightingStatus === 'fallback' && (
            <Text type="warning">高级高亮未加载，基础编辑仍可使用</Text>
          )}
          {!formatSupported && (
            <Text type="secondary">此语法仅高亮，不自动改写</Text>
          )}
          <Tooltip title={formatSupported ? '按当前语法整理缩进与排版，不会自动保存' : '当前语法没有可靠的标准格式化器'}>
            <span>
              <Button
                icon={<FormatPainterOutlined />}
                disabled={!formatSupported}
                loading={formatting}
                onClick={() => void runFormatter()}
              >
                格式化
              </Button>
            </span>
          </Tooltip>
        </Space>
      </div>
      <div className="toolkit-code-editor-frame">
        <Suspense fallback={<div className="toolkit-code-editor-loading" style={{ height }}><Spin tip="正在加载编辑器" /></div>}>
          <MonacoConfigEditor
            value={value}
            onChange={onChange}
            language={language}
            virtualPath={virtualPath}
            ariaLabel={ariaLabel}
            height={height}
            onSave={onSave}
            onHighlightingStatusChange={setHighlightingStatus}
          />
        </Suspense>
      </div>
      {onSave && <Text className="toolkit-code-editor-hint" type="secondary">可按 Ctrl/⌘ + S 保存</Text>}
    </div>
  );
}
