import { memo, useMemo, useState, useCallback, Fragment, type ReactNode } from 'react';
import { Avatar, message as toast } from 'antd';
import {
  WarningOutlined, StopOutlined,
  FileOutlined, EditOutlined, CodeOutlined, SearchOutlined,
  FolderOpenOutlined, GlobalOutlined, BranchesOutlined, ToolOutlined
} from '@ant-design/icons';
import type { ChatMessage, Provider, Session } from '@/types';
import { parseMessageBlocks } from './message-structure';
import {
  getRenderablePendingBlocks,
  hasRenderablePendingBlocks,
  normalizePendingTextBlock
} from './pending-message-presentation.js';
import { normalizePendingStatusText } from './provider-pending-policy.js';
import ProviderIcon from './ProviderIcon';
import FileDrawer, { type FileDrawerTab } from './FileDrawer';
import AuthorizedMarkdownImage from './AuthorizedMarkdownImage';
import MemoryCitationBlock from './MemoryCitationBlock';
import UserInputRequestBlock from './UserInputRequestBlock';
import GoalBlock from './GoalBlock';
import PlanBlock from './PlanBlock';
import CandidatePlanBlock from './CandidatePlanBlock';
import TaskNotificationBlock from './TaskNotificationBlock';
import SubagentThreadBlock from './SubagentThreadBlock';
import { getSubagentResultStatusPresentation } from './subagent-thread-state';
import ThinkingBlock from './ThinkingBlock';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';
import FileReferenceButton from './FileReferenceButton';
import UserAnswersBlock from './UserAnswersBlock';
import MessageMetadata from './MessageMetadata';
import { toProviderBlocks, isGoalContextTag, type ProviderBlock } from './provider-blocks';
import { basenameLike, getFileTabKey } from './file-reference-utils';
import { buildFileBackedImageUrl, buildMarkdownImageSource, getFilePreviewKind } from './file-preview-utils';
import ImageReferenceContent, { ImageGallery } from './MessageImages';
import {
  buildPathScopedImageFallbackMap,
  buildSingleImageReferenceSourceList,
  getReferencedImageIndexes,
  stripImageReferenceMarkup,
  type PathScopedImageFallbackMap,
  type PathScopedImageFallbackTarget
} from './image-reference-utils';
import styles from './chat.module.css';
import { isExternalHttpUrl, openExternalUrl } from '@/services/open-external-url';

interface Props {
  message: ChatMessage;
  provider: Provider;
  session?: Pick<Session, 'projectPath' | 'projectDirName'> | null;
  mobile?: boolean;
}

function detectReadLabelFromCommand(command: string) {
  const text = String(command || '');
  const pathMatch = text.match(/["']([^"']+\.[a-zA-Z0-9_-]+)["']/);
  if (pathMatch?.[1] && /(?:^|\s)(cat|sed|nl|head|tail|less|more|bat|rg)\b/.test(text)) {
    return `读取 ${basenameLike(pathMatch[1])}`;
  }
  return '';
}

function getToolItemLabel(name: string, body: string, result?: string) {
  const path = extractPathFromBody(body);
  const pathLabel = path ? basenameLike(path) : basenameLike(body);
  if (name === 'Read' || name === 'ReadFile' || name === 'read_file' || name === 'ViewFile' || name === 'view_file' || name === 'View') return `读取 ${pathLabel}`;
  if (name === 'Write' || name === 'WriteFile' || name === 'write_file' || name === 'create_file') return `写入 ${pathLabel}`;
  if (name === 'Edit' || name === 'EditFile' || name === 'edit_file' || name === 'str_replace_editor' || name === 'str_replace_based_edit_tool') return `编辑 ${pathLabel}`;
  if (name === 'Terminal') {
    const readLabel = detectReadLabelFromCommand(body);
    if (readLabel) return readLabel;
    const cmdLine = String(body || '').split('\n')[0].trim();
    if (/npm\s+run\s+([^\s]+)/.test(cmdLine)) return `执行 npm run ${cmdLine.match(/npm\s+run\s+([^\s]+)/)?.[1] || ''}`.trim();
    if (/node\s+--test\b/.test(cmdLine)) return '运行测试';
    if (/git\s+diff\b/.test(cmdLine)) return '检查代码差异';
    const firstOutput = String(result || '').split('\n').map((line) => line.trim()).find(Boolean);
    if (firstOutput) return firstOutput.length > 64 ? firstOutput.slice(0, 64) + '...' : firstOutput;
    return cmdLine.length > 64 ? cmdLine.slice(0, 64) + '...' : (cmdLine || '已运行命令');
  }
  return name;
}

function getToolItemKind(item: { name: string; body: string; result?: string }) {
  const n = item.name;
  if (n === 'Read' || n === 'ReadFile' || n === 'read_file' || n === 'ViewFile' || n === 'view_file' || n === 'View') return 'read';
  if (n === 'Write' || n === 'Edit' || n === 'WriteFile' || n === 'EditFile' || n === 'write_file' || n === 'edit_file' || n === 'create_file' || n === 'str_replace_editor' || n === 'str_replace_based_edit_tool') return 'edit';
  if ((n === 'Terminal' || n === 'Bash') && detectReadLabelFromCommand(item.body)) return 'read';
  return 'command';
}

// 所有 provider 里"文件操作"的工具名映射 —— 统一提取路径以显示文件图标。
// Codex/Claude Code: Read/Write/Edit；Gemini/AGY 变体：ReadFile/view_file 等；
// 通用兜底：str_replace_editor 类。
const FILE_OP_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'View',
  'ReadFile', 'WriteFile', 'EditFile', 'ViewFile',
  'read_file', 'write_file', 'edit_file', 'view_file', 'create_file',
  'str_replace_editor', 'str_replace_based_edit_tool',
  // 看图工具:参数含 {path}，走 extractPathFromBody 解析→图片预览，而非把 JSON 当代码块展示
  'view_image', 'ViewImage', 'view_img',
]);

function extractPathFromBody(body: string): string {
  const text = String(body || '').trim();
  if (!text) return '';
  // 直接路径（第一行是绝对路径）
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (firstLine.startsWith('/') || firstLine.startsWith('~')) return firstLine;
  // JSON body（部分 provider 把工具参数序列化为 JSON）
  try {
    const parsed = JSON.parse(text);
    const path = parsed?.path ?? parsed?.file_path ?? parsed?.filename ?? parsed?.filepath;
    if (typeof path === 'string' && (path.startsWith('/') || path.startsWith('~'))) return path;
  } catch {
    // not JSON
  }
  return '';
}

function getToolPreviewPath(name: string, body: string) {
  if (FILE_OP_TOOL_NAMES.has(name)) return extractPathFromBody(body);
  return '';
}

function getToolGroupSummary(items: Array<{ name: string; body: string; result?: string }>) {
  let readCount = 0;
  let editCount = 0;
  let commandCount = 0;

  items.forEach((item) => {
    // 分组摘要按工具类别计数，不依赖展示文案，避免中英文文案变更影响逻辑。
    const kind = getToolItemKind(item);
    if (kind === 'read') {
      readCount += 1;
      return;
    }
    if (kind === 'edit') {
      editCount += 1;
      return;
    }
    commandCount += 1;
  });

  const parts: string[] = [];
  if (readCount > 0) parts.push(`读取 ${readCount} 个文件`);
  if (editCount > 0) parts.push(`编辑 ${editCount} 个文件`);
  if (commandCount > 0) parts.push(`执行 ${commandCount} 个命令`);
  return parts.length > 0 ? parts.join('，') : `${items.length} 个操作`;
}

function splitFileActionLabel(label: string) {
  const match = String(label || '').match(/^(读取|写入|编辑)\s+(.+)$/);
  if (!match) return null;
  return {
    verb: match[1],
    target: match[2]
  };
}

const FileActionLink = ({
  label,
  path,
  onOpenFile
}: {
  label: string;
  path: string;
  onOpenFile: (path: string) => void;
}) => {
  // 文件工具项以弱链接承载“可打开”语义，避免每行额外按钮造成视觉噪声。
  const actionLabel = splitFileActionLabel(label);
  const verb = actionLabel?.verb || '打开';
  const target = actionLabel?.target || basenameLike(path);

  return (
    <FileReferenceButton
      path={path}
      verb={verb}
      label={target}
      variant="tool"
      onOpenFile={onOpenFile}
    />
  );
};

function cleanTerminalResultText(text: string) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  const cleaned: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (/^Chunk ID:\s*/.test(line)) {
      index += 1;
      while (
        index < lines.length
        && !/^Output:\s*(.*)$/.test(lines[index])
        && !/^Chunk ID:\s*/.test(lines[index])
      ) {
        index += 1;
      }
      if (index < lines.length && /^Output:\s*(.*)$/.test(lines[index])) {
        const outputMatch = lines[index].match(/^Output:\s*(.*)$/);
        if (outputMatch?.[1]) cleaned.push(outputMatch[1]);
        index += 1;
        while (index < lines.length && !/^Chunk ID:\s*/.test(lines[index])) {
          cleaned.push(lines[index]);
          index += 1;
        }
      }
      continue;
    }

    const plainOutputMatch = line.match(/^Output:\s*(.*)$/);
    if (plainOutputMatch) {
      if (plainOutputMatch[1]) cleaned.push(plainOutputMatch[1]);
      index += 1;
      continue;
    }

    if (
      /^Wall time:\s*/.test(line)
      || /^Process (?:running|exited) with session ID\s*/.test(line)
      || /^Original token count:\s*/.test(line)
    ) {
      index += 1;
      continue;
    }

    cleaned.push(line);
    index += 1;
  }

  return cleaned.join('\n').trim();
}

function extractShellDurationLabel(rawResult: string) {
  const text = String(rawResult || '');
  const wallMatch = text.match(/Wall time:\s*([0-9.]+)\s*seconds?/i);
  if (!wallMatch || !wallMatch[1]) return '';
  const seconds = Number(wallMatch[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  if (remain <= 0) return `${minutes}m`;
  return `${minutes}m ${remain}s`;
}

/** 判断是否为错误消息 */
function isErrorMessage(c: string): boolean {
  const t = c.trim();
  return t.startsWith('API Error:') || t.startsWith('Error:') || (t.startsWith('{') && t.includes('"error"'));
}

// 用户主动中断(Ctrl+C / ESC)会向会话注入形如 [Request interrupted by user] 的标记(claude 还有
// 「…for tool use」变体)。它是 role=user 消息,若当普通气泡渲染会像是用户输入了这句话——改成
// 居中的中断提示条。
function getInterruptMarkerText(content: string): string | null {
  const t = String(content || '').trim();
  if (/^\[request interrupted by user[^\]]*\]$/i.test(t)) return '用户已中断';
  return null;
}

function parseAttachedImageBlock(content: string) {
  const text = String(content || '');
  const imagePaths: string[] = [];
  let remainingText = text;

  // 兼容历史的本地附件提示块
  const lines = text.split('\n');
  if (lines.length >= 3 && lines[0].trim() === 'Attached image files:') {
    let index = 1;
    while (index < lines.length && lines[index].trim().startsWith('- ')) {
      imagePaths.push(lines[index].trim().slice(2).trim());
      index += 1;
    }
    if (index < lines.length && lines[index].trim() === 'Please inspect these local image files directly when answering.') {
      index += 1;
    }
    while (index < lines.length && lines[index].trim() === '') index += 1;
    remainingText = lines.slice(index).join('\n').trim();
  }

  // 兼容 Claude/Codex 的图片标记
  const regex = /\[Image:(?:\s*source:)?\s*(.*?)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }

  if (imagePaths.length > 0) {
    remainingText = remainingText.replace(regex, '').trim();
  }

  // 清理图片标签，避免作为普通文本显示
  remainingText = stripImageReferenceTags(remainingText);

  return {
    text: remainingText,
    imagePaths
  };
}

function stripImageReferenceTags(content: string) {
  return stripImageReferenceMarkup(content);
}

function toServedImageUrl(filePath: string) {
  return `/v0/webui/chat/attachments?path=${encodeURIComponent(filePath)}`;
}

function toRenderableImageUrl(source: string) {
  const value = String(source || '').trim();
  if (!value) return '';
  if (/^(data:image\/|blob:|https?:\/\/)/i.test(value)) return value;
  if (value.startsWith('/v0/webui/chat/attachments')) return value;
  if (value.startsWith('file://')) {
    try {
      return toServedImageUrl(decodeURIComponent(new URL(value).pathname));
    } catch (_error) {
      return '';
    }
  }
  return toServedImageUrl(value);
}

function normalizeRenderableImages(images: string[]) {
  const seen = new Set<string>();
  return (Array.isArray(images) ? images : [])
    .map(toRenderableImageUrl)
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function isImagePreviewPath(filePath: string) {
  return Boolean(filePath) && getFilePreviewKind(filePath) === 'image';
}

type ToolImageFallbackMap = PathScopedImageFallbackMap;

function getToolImageFallbackTargets(blocks: ReturnType<typeof parseMessageBlocks>) {
  const targets: PathScopedImageFallbackTarget[] = [];

  const collectToolItem = (item: { name: string; body: string }) => {
    const previewPath = getToolPreviewPath(item.name, item.body);
    if (!previewPath) return;
    targets.push({
      path: previewPath,
      isImage: isImagePreviewPath(previewPath)
    });
  };

  blocks.forEach((block) => {
    if (block.type === 'tool_use') {
      collectToolItem(block);
      return;
    }
    if (block.type === 'tool_group') {
      block.items.forEach(collectToolItem);
    }
  });

  return targets;
}

function buildToolImageFallbackMap(blocks: ReturnType<typeof parseMessageBlocks>, fallbackImages: string[]) {
  return buildPathScopedImageFallbackMap(getToolImageFallbackTargets(blocks), fallbackImages);
}

function getToolResultImages(
  item: { name: string; body: string; result?: string },
  fallbackImages: string[],
  options: { projectPath?: string; fallbackImageByPath?: ToolImageFallbackMap } = {}
) {
  const previewPath = getToolPreviewPath(item.name, item.body);
  if (!isImagePreviewPath(previewPath)) return fallbackImages;

  // Read 图片结果必须和右侧抽屉共用同一条媒体路由，避免气泡缩略图和抽屉预览读到不同来源。
  const imageSource = buildFileBackedImageUrl(previewPath, options.projectPath);
  if (!imageSource) return fallbackImages;

  return buildSingleImageReferenceSourceList(
    item.result || '',
    imageSource,
    fallbackImages,
    {
      fallbackSource: options.fallbackImageByPath?.[previewPath],
      allowIndexedFallback: false
    }
  );
}

/** 通用标签渲染块 */
/** 工具语义图标（ant-design，统一在事件语义色下渲染） */
function getToolIcon(name: string) {
  const n = String(name || '');
  if (n === 'Bash' || n === 'Terminal' || n === 'Shell') return <CodeOutlined />;
  if (n === 'Git') return <BranchesOutlined />;
  if (/^(Read|ReadFile|read_file|View|ViewFile|view_file|Cat)$/.test(n)) return <FileOutlined />;
  if (/^(Write|WriteFile|write_file|create_file)$/.test(n)) return <FileOutlined />;
  if (/^(Edit|EditFile|edit_file|str_replace_editor|str_replace_based_edit_tool|apply_patch)$/.test(n)) return <EditOutlined />;
  if (/^(Grep|Search|grep_search|GrepSearch)$/.test(n)) return <SearchOutlined />;
  if (/^(Glob|LS|List|list_directory|ListDirectory)$/.test(n)) return <FolderOpenOutlined />;
  if (/^(WebFetch|WebSearch|fetch)$/.test(n)) return <GlobalOutlined />;
  return <ToolOutlined />;
}

/** Tool 块渲染（含 result） */
const ToolBlock = ({ name, body, result, images = [], projectPath, toolImageFallbackMap = {}, mobile = false, mdComponents, onOpenFile }: { name: string; body: string; result?: string; images?: string[]; projectPath?: string; toolImageFallbackMap?: ToolImageFallbackMap; mobile?: boolean; mdComponents?: any; onOpenFile?: (path: string, options?: { source?: string }) => void }) => {
  // 专有工具（checklist / goal / plan / question / answers / shell）已在 provider-blocks
  // 归一阶段分流，这里只负责【通用工具】的渲染（文件预览 / 代码体 / 结果）。
  const cleanedResult = name === 'Terminal' ? cleanTerminalResultText(result || '') : (result || '');
  const previewPath = getToolPreviewPath(name, body);
  const resultImages = getToolResultImages({ name, body, result: cleanedResult }, images, { projectPath, fallbackImageByPath: toolImageFallbackMap });

  // 通用渲染
  return (
    <EventBlock tone="tool" icon={getToolIcon(name)} collapsible={false} barePadding title={name} aria-label={`工具 ${name}`}>
      {body && (
        <div className={styles.toolBody}>
          {previewPath && onOpenFile ? (
            <FileActionLink label={getToolItemLabel(name, body, cleanedResult)} path={previewPath} onOpenFile={onOpenFile} />
          ) : (
            <code style={{ fontSize: mobile ? 13 : 12, wordBreak: 'break-all' }}>{body}</code>
          )}
        </div>
      )}
      {cleanedResult && (
        <div className={`${styles.toolBody} ${styles.toolResultBody}`}>
          <ImageReferenceContent
            value={cleanedResult}
            images={resultImages}
            mobile={mobile}
            markdown
            markdownComponents={mdComponents}
            presentation={previewPath && isImagePreviewPath(previewPath) ? 'media' : 'inline'}
          />
        </div>
      )}
    </EventBlock>
  );
};

const ShellToolBlock = ({
  name,
  body,
  rawResult,
  cleanedResult
}: {
  name: string;
  body: string;
  rawResult: string;
  cleanedResult: string;
}) => {
  const shellCommand = String(body || '').split('\n').find((line) => !line.startsWith('# cwd:')) || String(body || '').split('\n')[0] || '';
  const durationLabel = extractShellDurationLabel(rawResult);
  const shellHeader = `已运行命令${durationLabel ? ` (${durationLabel})` : ''}`;

  return (
    <EventBlock tone="tool" icon={getToolIcon(name)} title={shellHeader} preview={shellCommand} barePadding aria-label="终端命令">
      <div className={styles.shellCommandBlock}>
        <pre className={styles.shellCommandCode}>{`$ ${shellCommand}`}</pre>
      </div>
      {cleanedResult && (
        <div className={styles.shellOutputBlock}>
          <pre className={styles.shellOutputCode}>{cleanedResult}</pre>
          <div className={styles.shellStatus}>✓ 成功</div>
        </div>
      )}
    </EventBlock>
  );
};

const ToolGroupBlock = ({ items, images = [], projectPath, toolImageFallbackMap = {}, mobile = false, mdComponents, onOpenFile }: { items: Array<{ name: string; body: string; result?: string }>; images?: string[]; projectPath?: string; toolImageFallbackMap?: ToolImageFallbackMap; mobile?: boolean; mdComponents?: any; onOpenFile?: (path: string, options?: { source?: string }) => void }) => {
  const summary = getToolGroupSummary(items);

  return (
    <EventBlock tone="tool" icon={<ToolOutlined />} title={summary} barePadding aria-label="工具调用组">
        <div className={styles.toolGroupList}>
          {items.map((item, index) => {
            const label = getToolItemLabel(item.name, item.body, item.result);
            const previewPath = getToolPreviewPath(item.name, item.body);
            const canPreview = Boolean(previewPath && onOpenFile);
            const resultImages = getToolResultImages(item, images, { projectPath, fallbackImageByPath: toolImageFallbackMap });
            return (
              <div
                key={`${item.name}-${index}`}
                className={`${styles.toolGroupItem} ${canPreview ? styles.toolGroupItemInteractive : ''}`}
                onClick={() => {
                  if (canPreview) onOpenFile?.(previewPath);
                }}
              >
                {canPreview ? (
                  <FileActionLink label={label} path={previewPath} onOpenFile={(filePath) => onOpenFile?.(filePath)} />
                ) : (
                  <div className={styles.toolGroupItemLabel}>{label}</div>
                )}
                {item.result ? (
                  <div className={styles.toolGroupItemResult}>
                    <ImageReferenceContent
                      value={item.result}
                      images={resultImages}
                      mobile={mobile}
                      markdown
                      markdownComponents={mdComponents}
                      presentation={previewPath && isImagePreviewPath(previewPath) ? 'media' : 'inline'}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
    </EventBlock>
  );
};

const PendingStatusLine = ({ text }: { text: string }) => {
  const chars = Array.from(text || '');
  return (
    <div className={styles.pendingInlineStatus} aria-live="polite" aria-label={text}>
      {chars.map((char, index) => (
        <span
          key={`${char}-${index}`}
          className={styles.pendingInlineChar}
          style={{ animationDelay: `${index * 0.08}s` }}
          aria-hidden="true"
        >
          {char === ' ' ? '\u00A0' : char}
        </span>
      ))}
    </div>
  );
};

const MessageBubble = ({ message, provider, session, mobile = false }: Props) => {
  const isUser = message.role === 'user';
  const showAssistantAvatar = !mobile;
  const [metaVisible, setMetaVisible] = useState(false);
  const parsedAttachmentBlock = useMemo(() => parseAttachedImageBlock(message.content), [message.content]);
  const inlineImages = useMemo(() => normalizeRenderableImages(message.images || []), [message.images]);
  const persistedImages = useMemo(
    () => normalizeRenderableImages(parsedAttachmentBlock.imagePaths),
    [parsedAttachmentBlock.imagePaths]
  );
  const renderedImages = inlineImages.length > 0 ? inlineImages : persistedImages;
  const messageText = renderedImages.length > 0
    ? parsedAttachmentBlock.text
    : message.content;
  const blockSource = renderedImages.length > 0 ? messageText : (messageText || message.content);
  const blocks = useMemo(() => parseMessageBlocks(blockSource), [blockSource]);
  const toolImageFallbackMap = useMemo(
    () => buildToolImageFallbackMap(blocks, renderedImages),
    [blocks, renderedImages]
  );
  const galleryImages = useMemo(() => {
    const referencedIndexes = getReferencedImageIndexes(blockSource, renderedImages.length);
    return renderedImages.filter((_, index) => !referencedIndexes.has(index));
  }, [blockSource, renderedImages]);
  const hasStructuredUserBlocks = isUser && blocks.some((block) =>
    block.type === 'tag' && (
      isGoalContextTag(block.name, block.value)
      || block.name === 'request_user_input'
      // 后台任务通知(task-notification)在 claude 会话里作为 user 消息注入,需走结构化渲染
      // (TaskNotificationBlock)而不是把原始 <task-notification> XML 当纯文本展示。
      || block.name === 'task-notification'
    )
  );
  const resolvedProjectPath = useMemo(() => {
    let cwd = session?.projectPath;
    for (const block of blocks) {
      if (block.type === 'tag' && block.name === 'environment_context') {
        const cwdMatch = block.value.match(/<cwd>([^<]+)<\/cwd>/);
        if (cwdMatch && cwdMatch[1]) {
          cwd = cwdMatch[1].trim();
        }
      }
    }
    return cwd;
  }, [blocks, session?.projectPath]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('');
  const [tabs, setTabs] = useState<FileDrawerTab[]>([]);

  const handleOpenFile = useCallback((filePath: string, options: { source?: string } = {}) => {
    setTabs(prev => {
      if (!prev.find(t => t.path === filePath && t.source === options.source)) {
        // Codex 记忆引用由后端按 memories 根目录解析，不能混入当前项目路径。
        const projectPath = options.source === 'codex-memory' ? undefined : resolvedProjectPath;
        return [...prev, { path: filePath, title: basenameLike(filePath), projectPath, source: options.source }];
      }
      return prev;
    });
    setActiveTab(getFileTabKey(filePath, options.source));
    setDrawerOpen(true);
  }, [resolvedProjectPath]);

  const mdComponents = useMemo(() => ({
    a({ _node, href, children, ...props }: any) {
      if (href) {
        let localPath = '';
        try {
          const url = new URL(href, window.location.origin);
          if (url.protocol === 'file:') {
            // provider CLI（agy/claude 等）常以 file:///abs/path 引用生成文件。浏览器禁止
            // 从 http 页面打开 file:// 链接（新窗口分支必然打不开），本地路径一律走右侧预览。
            localPath = decodeURIComponent(url.pathname);
          } else if (url.origin === window.location.origin && url.pathname.startsWith('/')) {
             if (!url.pathname.startsWith('/ui/') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v0/')) {
               localPath = decodeURIComponent(url.pathname);
             }
          }
        } catch (_error) {}

        if (localPath) {
          return (
            <FileReferenceButton
              path={localPath}
              label={children}
              onOpenFile={handleOpenFile}
            />
          );
        }
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (!href || !isExternalHttpUrl(href)) return;
            event.preventDefault();
            void openExternalUrl(href).catch(() => toast.error('无法打开外部链接'));
          }}
          {...props}
        >
          {children}
        </a>
      );
    },
    img({ _node, src, ...props }: any) {
      const imageSource = buildMarkdownImageSource(String(src || ''), {
        baseDirectory: resolvedProjectPath,
        projectPath: resolvedProjectPath
      });
      return (
        <AuthorizedMarkdownImage
          {...props}
          source={imageSource}
          className={styles.filePreviewInlineImage}
          alt={props.alt || ''}
        />
      );
    }
  }), [handleOpenFile, resolvedProjectPath]);

  // 归一渲染：消费 canonical ProviderBlock，按 kind 映射到叶子组件。
  // 渲染器不再认 provider 私有名（分类已在 provider-blocks.toProviderBlocks 完成）。
  const renderCanonicalBlock = useCallback((
    block: ProviderBlock,
    variant: 'assistant' | 'user' | 'pending'
  ): ReactNode => {
    switch (block.kind) {
      case 'text': {
        if (!String(block.value || '').trim()) return null;
        if (variant === 'pending') {
          return <div className={styles.pendingTextBlock}>{normalizePendingTextBlock(block.value)}</div>;
        }
        if (variant === 'user') {
          return (
            <div className={styles.userStructuredText}>
              <ImageReferenceContent value={block.value} images={renderedImages} mobile={mobile} markdownComponents={mdComponents} />
            </div>
          );
        }
        return (
          <ImageReferenceContent value={block.value} images={renderedImages} mobile={mobile} markdown markdownComponents={mdComponents} />
        );
      }
      case 'reasoning':
        return <ThinkingBlock value={block.value} mobile={mobile} components={mdComponents} />;
      case 'checklist':
        return <PlanBlock checklist={block.checklist} result={block.checklist.result} mobile={mobile} />;
      case 'plan_text':
        return <CandidatePlanBlock value={block.value} mobile={mobile} mdComponents={mdComponents} />;
      case 'question':
        return <UserInputRequestBlock body={block.body} result={block.result} mobile={mobile} />;
      case 'answers':
        return <UserAnswersBlock value={block.value} mobile={mobile} />;
      case 'goal':
        return <GoalBlock context={block.context} body={block.body} result={block.result} />;
      case 'memory_citation':
        return <MemoryCitationBlock value={block.value} onOpenFile={handleOpenFile} />;
      case 'task_event':
        return <TaskNotificationBlock value={block.value} onOpenFile={handleOpenFile} />;
      case 'shell':
        return (
          <ShellToolBlock
            name={block.name}
            body={block.body}
            rawResult={block.result || ''}
            cleanedResult={block.name === 'Terminal' ? cleanTerminalResultText(block.result || '') : (block.result || '')}
          />
        );
      case 'subagent': {
        if (block.childSessionId) {
          const childSession = session
            ? {
                ...session,
                id: block.childSessionId,
                title: block.description,
                provider
              }
            : null;
          return (
            <SubagentThreadBlock
              description={block.description}
              prompt={block.prompt}
              childSessionId={block.childSessionId}
              agentNickname={block.agentNickname}
              taskStatus={block.status}
              updatedAt={block.updatedAt}
              provider={provider}
              projectDirName={session?.projectDirName}
              mobile={mobile}
              renderMessage={(childMessage, index) => (
                <MessageBubble
                  key={`${childMessage.role}-${index}`}
                  message={childMessage}
                  provider={provider}
                  session={childSession}
                  mobile={mobile}
                />
              )}
            />
          );
        }
        // 并行子代理任务卡：标题=任务描述（多个子代理各自成卡、一眼可区分），
        // 折叠体=派发的 prompt + 子代理产出（markdown）。状态取自产出内容。
        const resultText = String(block.result || '').trim();
        const status = getSubagentResultStatusPresentation(resultText);
        return (
          <EventBlock
            tone="plan"
            icon={<BranchesOutlined />}
            title={`子代理 · ${block.description}`}
            status={status}
            collapsible
            defaultOpen={Boolean(resultText)}
            dense={mobile}
            aria-label={`子代理 ${block.description}`}
          >
            {block.prompt ? (
              <div className={evt.metaText} style={{ marginBottom: 'var(--space-5)', whiteSpace: 'pre-wrap' }}>
                {block.prompt.length > 400 ? `${block.prompt.slice(0, 400)}…` : block.prompt}
              </div>
            ) : null}
            {resultText ? (
              <div className={evt.prose}>
                <ImageReferenceContent value={resultText} images={renderedImages} mobile={mobile} markdown markdownComponents={mdComponents} />
              </div>
            ) : null}
          </EventBlock>
        );
      }
      case 'tool':
        return (
          <ToolBlock
            name={block.name}
            body={block.body}
            result={block.result}
            images={renderedImages}
            projectPath={resolvedProjectPath}
            toolImageFallbackMap={toolImageFallbackMap}
            mobile={mobile}
            mdComponents={mdComponents}
            onOpenFile={handleOpenFile}
          />
        );
      case 'tool_group':
        return (
          <ToolGroupBlock
            items={block.items}
            images={renderedImages}
            projectPath={resolvedProjectPath}
            toolImageFallbackMap={toolImageFallbackMap}
            mobile={mobile}
            mdComponents={mdComponents}
            onOpenFile={handleOpenFile}
          />
        );
      case 'generic_tag': {
        if (block.orphanClose) {
          return <EventBlock tone="neutral" title={`/${block.name}`} collapsible={false} dense={mobile} aria-label={`标签 /${block.name}`} />;
        }
        const isMultiline = block.value.includes('\n');
        const preview = block.value.split('\n')[0].slice(0, 60) + (block.value.length > 60 ? '...' : '');
        return (
          <EventBlock tone="neutral" title={block.name} preview={isMultiline ? preview : undefined} collapsible={isMultiline} dense={mobile} flushBody aria-label={`标签 ${block.name}`}>
            {block.value ? <div className={`${evt.prose}${isMultiline ? ` ${evt.scroll}` : ''}`}>{block.value}</div> : null}
          </EventBlock>
        );
      }
    }
  }, [handleOpenFile, mdComponents, mobile, provider, renderedImages, resolvedProjectPath, session, toolImageFallbackMap]);

  const renderBlockList = useCallback((source: ProviderBlock[], variant: 'assistant' | 'user' | 'pending') => (
    source.map((block, index) => {
      const node = renderCanonicalBlock(block, variant);
      return node == null ? null : <Fragment key={`${block.kind}-${index}`}>{node}</Fragment>;
    })
  ), [renderCanonicalBlock]);

  const assistantBlocks = useMemo(() => toProviderBlocks(blocks), [blocks]);

  const handleMessageTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!mobile) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, label, img, video, [role="button"], .ant-image, .ant-image-preview-root')) {
      return;
    }
    setMetaVisible((current) => !current);
  };

  const interruptText = getInterruptMarkerText(message.content);
  if (interruptText) {
    return (
      <div className={styles.interruptRow}>
        <span className={styles.interruptNote}>
          <StopOutlined />
          {interruptText}
        </span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className={`${styles.messageRow} ${styles.messageRowUser}`}>
        <div className={`${styles.messageWrapper} ${styles.messageWrapperUser}`} onClick={handleMessageTap}>
          <div className={`${styles.bubbleUser} ${hasStructuredUserBlocks ? styles.bubbleUserStructured : ''}`}>
            <ImageGallery images={galleryImages} />
            {hasStructuredUserBlocks ? (
              renderBlockList(assistantBlocks, 'user')
            ) : (
              messageText ? (
                <ImageReferenceContent
                  value={messageText}
                  images={renderedImages}
                  mobile={mobile}
                  markdownComponents={mdComponents}
                />
              ) : (
                renderedImages.length > 0 ? '已附加图片' : ''
              )
            )}
          </div>
          <MessageMetadata
            role={message.role}
            timestamp={message.timestamp}
            model={message.model}
            copyText={messageText || message.content}
            actionsVisible={metaVisible}
          />
        </div>
        {hasStructuredUserBlocks ? (
          <FileDrawer
            open={drawerOpen}
            tabs={tabs}
            activeKey={activeTab}
            onClose={() => setDrawerOpen(false)}
            onChangeTab={setActiveTab}
          />
        ) : null}
      </div>
    );
  }

  if (isErrorMessage(message.content)) {
    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        {showAssistantAvatar ? (
          <Avatar size={32} className={styles.avatarAi} style={{ background: '#fff2f0', border: '1px solid #ffccc7' }}>
            <WarningOutlined style={{ color: '#cf1322', fontSize: 16 }} />
          </Avatar>
        ) : null}
        <div className={`${styles.messageWrapper} ${styles.messageWrapperAssistant}`} onClick={handleMessageTap}>
          <div className={styles.bubbleError}>{message.content}</div>
          <MessageMetadata
            role={message.role}
            timestamp={message.timestamp}
            model={message.model}
            copyText={message.content}
            actionsVisible={metaVisible}
          />
        </div>
      </div>
    );
  }

  if (message.pending) {
    const pendingStatusText = normalizePendingStatusText(message.statusText || '正在思考中', provider);
    const pendingProviderBlocks = toProviderBlocks(getRenderablePendingBlocks(blocks));
    const hasLiveDetail = hasRenderablePendingBlocks(blocks);

    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        {showAssistantAvatar ? (
          <Avatar size={32} className={styles.avatarAi}>
            <ProviderIcon provider={provider} size={18} />
          </Avatar>
        ) : null}
        <div className={`${styles.messageWrapper} ${styles.messageWrapperAssistant}`} onClick={handleMessageTap}>
          <div className={`${styles.bubbleAssistant} ${styles.bubbleAssistantPending} ${!hasLiveDetail ? styles.bubbleAssistantPendingCompact : ''}`}>
            <div className={styles.pendingInline}>
              <span className={styles.srOnly}>{pendingStatusText}</span>
              <PendingStatusLine text={pendingStatusText} />
            </div>
            {hasLiveDetail ? (
              <div className={styles.pendingDetailBody}>
                {renderBlockList(pendingProviderBlocks, 'pending')}
              </div>
            ) : null}
          </div>
          <MessageMetadata
            role={message.role}
            timestamp={message.timestamp}
            model={message.model}
            copyText={message.content || ''}
            actionsVisible={metaVisible}
          />
        </div>
        <FileDrawer
          open={drawerOpen}
          tabs={tabs}
          activeKey={activeTab}
          onClose={() => setDrawerOpen(false)}
          onChangeTab={setActiveTab}
        />
      </div>
    );
  }

  return (
    <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
      {showAssistantAvatar ? (
        <Avatar size={32} className={styles.avatarAi}>
          <ProviderIcon provider={provider} size={18} />
        </Avatar>
      ) : null}
      <div className={`${styles.messageWrapper} ${styles.messageWrapperAssistant}`} onClick={handleMessageTap}>
        <div className={styles.bubbleAssistant}>
          <ImageGallery images={galleryImages} />
          {renderBlockList(assistantBlocks, 'assistant')}
        </div>
        <MessageMetadata
          role={message.role}
          timestamp={message.timestamp}
          model={message.model}
          copyText={messageText || message.content}
          actionsVisible={metaVisible}
        />
      </div>
      <FileDrawer
        open={drawerOpen}
        tabs={tabs}
        activeKey={activeTab}
        onClose={() => setDrawerOpen(false)}
        onChangeTab={setActiveTab}
      />
    </div>
  );
};

export default memo(MessageBubble);
