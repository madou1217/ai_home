import { memo, useEffect, useMemo, useState, type ImgHTMLAttributes } from 'react';
import { Alert, Button, Segmented, Spin, Switch } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import { useAuthorizedMediaUrl } from '@/hooks/useAuthorizedMediaUrl';
import MessageMarkdown from './MessageMarkdown';
import {
  buildFileMediaUrl,
  getDefaultPreviewMode,
  getFilePreviewKind,
  getPreviewLanguage,
  getPreviewModeOptions,
  type FilePreviewMode
} from './file-preview-utils';
import styles from './chat.module.css';

interface Props {
  path: string;
  content?: string;
  mediaUrl?: string;
  loading?: boolean;
  error?: string;
  projectPath?: string;
  source?: string;
}

// markdown 预览里的本地图片：provider CLI 生成的 artifact md（如 agy flash-image 的
// 插画）引用同目录/绝对路径的图片文件。浏览器无法直接加载 /Users/... 或 file://，
// 必须重写到 fs/media（与文件读取同一授权规则），相对路径按 md 所在目录解析。
function resolveLocalMarkdownAsset(src: string, mdPath: string): string {
  const value = String(src || '').trim();
  if (!value || /^(data:|blob:|https?:\/\/)/i.test(value)) return '';
  if (value.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch (_error) {
      return '';
    }
  }
  if (value.startsWith('/')) {
    if (value.startsWith('/v0/') || value.startsWith('/ui/') || value.startsWith('/api/')) return '';
    return value;
  }
  const baseDir = String(mdPath || '').split('/').slice(0, -1).join('/');
  if (!baseDir) return '';
  return `${baseDir}/${value.replace(/^\.\//, '')}`;
}

function getTextLineCount(content: string) {
  if (!content) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function formatTextBytes(content: string) {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;

  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function getContentMeta(content?: string) {
  if (typeof content !== 'string') return '';
  return `${getTextLineCount(content)} 行 · ${formatTextBytes(content)}`;
}

function createFencedCodeBlock(content: string, language: string) {
  const maxBackticks = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, maxBackticks + 1));
  // 用动态长度 fence 包裹源码，避免 Markdown 文件里自带 ``` 时破坏源码视图。
  return `${fence}${language}\n${content}\n${fence}`;
}

function SourcePreview({ content, language, softWrap }: { content: string; language: string; softWrap: boolean }) {
  const source = useMemo(() => createFencedCodeBlock(content, language), [content, language]);
  const wrapClassName = softWrap ? styles.filePreviewCodeSoftWrap : styles.filePreviewCodeNoWrap;

  return (
    <div className={`${styles.filePreviewCode} ${wrapClassName}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

function AuthorizedMarkdownImage({ source, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { source: string }) {
  const media = useAuthorizedMediaUrl(source);
  if (!media.url) return null;
  return (
    <img
      {...props}
      src={media.url}
      className={styles.filePreviewInlineImage}
      alt={alt || ''}
    />
  );
}

function RenderedMarkdownPreview({ content, softWrap, mdPath, projectPath, source }: {
  content: string;
  softWrap: boolean;
  mdPath: string;
  projectPath?: string;
  source?: string;
}) {
  const wrapClassName = softWrap ? styles.filePreviewCodeSoftWrap : styles.filePreviewCodeNoWrap;
  const components = useMemo(() => ({
    img({ _node, src, ...props }: any) {
      const localPath = resolveLocalMarkdownAsset(String(src || ''), mdPath);
      const finalSrc = localPath ? buildFileMediaUrl(localPath, projectPath, source) : src;
      return <AuthorizedMarkdownImage {...props} source={String(finalSrc || '')} alt={props.alt || ''} />;
    }
  }), [mdPath, projectPath, source]);

  return (
    <MessageMarkdown
      value={content}
      forceMarkdown
      components={components}
      className={`${styles.filePreviewMarkdown} ${wrapClassName}`}
    />
  );
}

function ImagePreview({ mediaUrl }: { mediaUrl: string }) {
  const [loadError, setLoadError] = useState(false);
  const media = useAuthorizedMediaUrl(mediaUrl);

  useEffect(() => setLoadError(false), [mediaUrl]);

  if (loadError || media.error) {
    return (
      <div className={styles.filePreviewState}>
        <Alert type="error" showIcon message="图片加载失败" description="请确认文件仍在当前项目目录内。" />
      </div>
    );
  }

  if (media.loading || !media.url) {
    return (
      <div className={styles.filePreviewState}>
        <Spin size="small" />
      </div>
    );
  }

  return (
    <div className={styles.filePreviewImageViewport}>
      <img
        src={media.url}
        alt=""
        className={styles.filePreviewImage}
        onError={() => setLoadError(true)}
      />
    </div>
  );
}

function RawMediaPreview({ mediaUrl }: { mediaUrl: string }) {
  const media = useAuthorizedMediaUrl(mediaUrl);
  return (
    <div className={styles.filePreviewRawMedia}>
      <div className={styles.filePreviewRawMediaTitle}>原始图片文件</div>
      <div className={styles.filePreviewRawMediaText}>
        二进制内容不进入源码视图，直接打开原文件更可靠。
      </div>
      <Button size="small" href={media.url || undefined} disabled={!media.url} target="_blank" rel="noreferrer">
        打开原图
      </Button>
    </div>
  );
}

function ModeSelector({
  mode,
  modeOptions,
  onModeChange
}: {
  mode: FilePreviewMode;
  modeOptions: Array<{ label: string; value: FilePreviewMode }>;
  onModeChange: (mode: FilePreviewMode) => void;
}) {
  if (modeOptions.length > 1) {
    return (
      <Segmented
        size="small"
        value={mode}
        onChange={(value) => onModeChange(value as FilePreviewMode)}
        options={modeOptions}
      />
    );
  }

  const [singleOption] = modeOptions;
  if (!singleOption) return null;

  return (
    <span className={styles.filePreviewModePill} aria-label={`当前预览模式：${singleOption.label}`}>
      {singleOption.label}
    </span>
  );
}

function PreviewToolbar({
  content,
  mode,
  modeOptions,
  softWrap,
  showWrap,
  onModeChange,
  onSoftWrapChange
}: {
  content?: string;
  mode: FilePreviewMode;
  modeOptions: Array<{ label: string; value: FilePreviewMode }>;
  softWrap: boolean;
  showWrap: boolean;
  onModeChange: (mode: FilePreviewMode) => void;
  onSoftWrapChange: (softWrap: boolean) => void;
}) {
  const contentMeta = getContentMeta(content);

  return (
    <div className={styles.filePreviewToolbar}>
      <div className={styles.filePreviewMeta}>{contentMeta}</div>
      <div className={styles.filePreviewControls}>
        <ModeSelector
          mode={mode}
          modeOptions={modeOptions}
          onModeChange={onModeChange}
        />
        {showWrap ? (
          <Switch
            size="small"
            checked={softWrap}
            checkedChildren="换行"
            unCheckedChildren="不换"
            onChange={onSoftWrapChange}
          />
        ) : null}
      </div>
    </div>
  );
}

function FilePreviewPane({ path, content, mediaUrl, loading = false, error = '', projectPath, source }: Props) {
  const kind = getFilePreviewKind(path);
  const defaultMode = getDefaultPreviewMode(kind);
  const [mode, setMode] = useState<FilePreviewMode>(defaultMode);
  const [softWrap, setSoftWrap] = useState(true);
  const markdown = kind === 'markdown';
  const language = getPreviewLanguage(path);
  const modeOptions = getPreviewModeOptions(kind);
  const waitingForContent = loading || (typeof content !== 'string' && !error);

  useEffect(() => {
    // 同一个预览 Pane 切换文件类型时，模式要回到该类型的默认入口。
    setMode(defaultMode);
  }, [defaultMode, path]);

  if (kind === 'image') {
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onModeChange={setMode}
          onSoftWrapChange={setSoftWrap}
        />
        {mediaUrl ? (
          mode === 'image' ? <ImagePreview mediaUrl={mediaUrl} /> : (
            <div className={styles.filePreviewViewport}>
              <RawMediaPreview mediaUrl={mediaUrl} />
            </div>
          )
        ) : (
          <div className={styles.filePreviewState}>
            <Alert type="error" showIcon message="图片预览地址缺失" />
          </div>
        )}
      </div>
    );
  }

  if (waitingForContent) {
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onModeChange={setMode}
          onSoftWrapChange={setSoftWrap}
        />
        <div className={styles.filePreviewState}>
          <Spin />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onModeChange={setMode}
          onSoftWrapChange={setSoftWrap}
        />
        <div className={styles.filePreviewState}>
          <Alert type="error" showIcon message="文件读取失败" description={error} />
        </div>
      </div>
    );
  }

  const previewMode = markdown ? mode : 'source';
  const fileContent = content || '';

  return (
    <div className={styles.filePreviewPane}>
      <PreviewToolbar
        content={fileContent}
        mode={mode}
        modeOptions={modeOptions}
        softWrap={softWrap}
        showWrap
        onModeChange={setMode}
        onSoftWrapChange={setSoftWrap}
      />
      <div className={styles.filePreviewViewport}>
        {previewMode === 'rendered' ? (
          <RenderedMarkdownPreview content={fileContent} softWrap={softWrap} mdPath={path} projectPath={projectPath} source={source} />
        ) : (
          <SourcePreview content={fileContent} language={language} softWrap={softWrap} />
        )}
      </div>
    </div>
  );
}

export default memo(FilePreviewPane);
