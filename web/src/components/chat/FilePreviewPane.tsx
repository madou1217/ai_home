import { memo, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Radio, Segmented, Spin, Switch } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import { useAuthorizedMediaUrl } from '@/hooks/useAuthorizedMediaUrl';
import type {
  FileRequestError,
  FileTrustCandidate,
  FileTrustScope
} from '@/services/api';
import AuthorizedMarkdownImage from './AuthorizedMarkdownImage';
import MessageMarkdown from './MessageMarkdown';
import {
  buildMarkdownImageSource,
  getFileParentPath,
  getDefaultPreviewMode,
  getFilePreviewKind,
  getPreviewLanguage,
  getPreviewModeOptions,
  normalizeHtmlPreviewDocument,
  type FilePreviewMode
} from './file-preview-utils';
import {
  openHtmlPreviewWindow,
  type HtmlPreviewDevice
} from './html-preview-window';
import styles from './chat.module.css';

interface Props {
  path: string;
  content?: string;
  mediaUrl?: string;
  loading?: boolean;
  error?: FileRequestError;
  trusting?: boolean;
  trustError?: string;
  projectPath?: string;
  source?: string;
  mdPath?: string;
  onReload?: () => void;
  onTrust?: (scope: FileTrustScope) => void;
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
      const finalSrc = buildMarkdownImageSource(String(src || ''), {
        baseDirectory: getFileParentPath(mdPath),
        projectPath,
        source
      });
      return (
        <AuthorizedMarkdownImage
          {...props}
          source={String(finalSrc || '')}
          className={styles.filePreviewInlineImage}
          alt={props.alt || ''}
        />
      );
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

function HtmlPreviewLauncher({ content, path }: { content: string; path: string }) {
  const previewDocument = useMemo(() => normalizeHtmlPreviewDocument(content), [content]);
  const title = path.split(/[\\/]/).pop() || 'HTML 预览';
  const openPreview = (device: HtmlPreviewDevice) => {
    openHtmlPreviewWindow(previewDocument, { device, title });
  };

  return (
    <section className={styles.filePreviewHtml} aria-label="HTML 独立预览">
      <header className={styles.filePreviewHtmlStatus}>
        <span className={styles.filePreviewHtmlStatusDot} aria-hidden />
        <strong>独立安全预览</strong>
        <span>脚本和网络资源可用；预览无法访问 AI Home 数据</span>
      </header>
      <div className={styles.filePreviewHtmlLauncher}>
        <div className={styles.filePreviewHtmlLauncherCopy}>
          <strong>选择预览设备</strong>
          <span>HTML 将在新标签页打开，可在页面内继续切换 PC 和手机视口。</span>
        </div>
        <div className={styles.filePreviewHtmlLauncherActions}>
          <Button type="primary" onClick={() => openPreview('desktop')}>PC 预览</Button>
          <Button onClick={() => openPreview('mobile')}>手机预览</Button>
        </div>
      </div>
    </section>
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
  onReload,
  onModeChange,
  onSoftWrapChange
}: {
  content?: string;
  mode: FilePreviewMode;
  modeOptions: Array<{ label: string; value: FilePreviewMode }>;
  softWrap: boolean;
  showWrap: boolean;
  onReload?: () => void;
  onModeChange: (mode: FilePreviewMode) => void;
  onSoftWrapChange: (softWrap: boolean) => void;
}) {
  const contentMeta = getContentMeta(content);

  return (
    <div className={styles.filePreviewToolbar}>
      <div className={styles.filePreviewMeta}>{contentMeta}</div>
      <div className={styles.filePreviewControls}>
        {onReload ? (
          <Button size="small" type="text" onClick={onReload}>刷新</Button>
        ) : null}
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

function FileTrustPrompt({
  filePath,
  candidates,
  trusting,
  trustError,
  onTrust
}: {
  filePath: string;
  candidates: FileTrustCandidate[];
  trusting: boolean;
  trustError: string;
  onTrust?: (scope: FileTrustScope) => void;
}) {
  const [selectedScope, setSelectedScope] = useState<FileTrustScope | undefined>(candidates[0]?.scope);
  const selectedCandidate = candidates.find((candidate) => candidate.scope === selectedScope);

  useEffect(() => {
    if (!candidates.some((candidate) => candidate.scope === selectedScope)) {
      setSelectedScope(candidates[0]?.scope);
    }
  }, [candidates, selectedScope]);

  if (candidates.length === 0) {
    return (
      <Alert
        type="warning"
        showIcon
        message="此位置不能直接授权"
        description="文件位于用户主目录或系统根级范围。请将文件移动到更具体的文件夹后再预览。"
      />
    );
  }

  return (
    <section className={styles.fileTrustCard} aria-label="文件夹信任授权">
      <div className={styles.fileTrustHeader}>
        <div className={styles.fileTrustTitle}>需要信任此文件位置</div>
        <div className={styles.fileTrustDescription}>
          该文件不在当前项目内。请选择允许 AI Home 只读预览的目录范围。
        </div>
      </div>
      <div className={styles.fileTrustTarget}>
        <span>目标文件</span>
        <code title={filePath}>{filePath}</code>
      </div>
      <Radio.Group
        className={styles.fileTrustOptions}
        value={selectedScope}
        onChange={(event) => setSelectedScope(event.target.value as FileTrustScope)}
      >
        {candidates.map((candidate) => (
          <Radio key={candidate.scope} value={candidate.scope} className={styles.fileTrustOption}>
            <span className={styles.fileTrustOptionContent}>
              <strong>{candidate.label}</strong>
              <code title={candidate.path}>{candidate.path}</code>
              <span>{candidate.description}</span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
      {trustError ? <Alert type="error" showIcon message="授权失败" description={trustError} /> : null}
      <div className={styles.fileTrustFooter}>
        <span>确认后会保存到当前 Server 的文件预览白名单。</span>
        <Button
          type="primary"
          loading={trusting}
          disabled={!selectedCandidate}
          onClick={() => selectedCandidate && onTrust?.(selectedCandidate.scope)}
        >
          信任并预览
        </Button>
      </div>
    </section>
  );
}

function FilePreviewPane({
  path,
  content,
  mediaUrl,
  loading = false,
  error,
  trusting = false,
  trustError = '',
  projectPath,
  source,
  mdPath,
  onReload,
  onTrust
}: Props) {
  const kind = getFilePreviewKind(path);
  const defaultMode = getDefaultPreviewMode(kind);
  const [mode, setMode] = useState<FilePreviewMode>(defaultMode);
  const [softWrap, setSoftWrap] = useState(true);
  const markdown = kind === 'markdown';
  const html = kind === 'html';
  const language = getPreviewLanguage(path);
  const modeOptions = getPreviewModeOptions(kind);
  const waitingForContent = loading || (kind === 'image'
    ? (!mediaUrl && !error)
    : (typeof content !== 'string' && !error));

  useEffect(() => {
    // 同一个预览 Pane 切换文件类型时，模式要回到该类型的默认入口。
    setMode(defaultMode);
  }, [defaultMode, path]);

  if (waitingForContent) {
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onReload={onReload}
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
    const authorization = error.authorization;
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onReload={onReload}
          onModeChange={setMode}
          onSoftWrapChange={setSoftWrap}
        />
        <div className={styles.filePreviewState}>
          {authorization?.required ? (
            <FileTrustPrompt
              filePath={authorization.filePath || path}
              candidates={authorization.candidates || []}
              trusting={trusting}
              trustError={trustError}
              onTrust={onTrust}
            />
          ) : (
            <Alert type="error" showIcon message="文件读取失败" description={error.message} />
          )}
        </div>
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div className={styles.filePreviewPane}>
        <PreviewToolbar
          mode={mode}
          modeOptions={modeOptions}
          softWrap={softWrap}
          showWrap={false}
          onReload={onReload}
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

  const previewMode = markdown || html ? mode : 'source';
  const fileContent = content || '';

  return (
    <div className={styles.filePreviewPane}>
      <PreviewToolbar
        content={fileContent}
        mode={mode}
        modeOptions={modeOptions}
        softWrap={softWrap}
        showWrap={!html || mode === 'source'}
        onReload={onReload}
        onModeChange={setMode}
        onSoftWrapChange={setSoftWrap}
      />
      {html && previewMode === 'rendered' ? (
        <HtmlPreviewLauncher content={fileContent} path={path} />
      ) : (
        <div className={styles.filePreviewViewport}>
          {previewMode === 'rendered' ? (
            <RenderedMarkdownPreview
              content={fileContent}
              softWrap={softWrap}
              mdPath={mdPath || path}
              projectPath={projectPath}
              source={source}
            />
          ) : (
            <SourcePreview content={fileContent} language={language} softWrap={softWrap} />
          )}
        </div>
      )}
    </div>
  );
}

export default memo(FilePreviewPane);
