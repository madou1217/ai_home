import { memo, useMemo, useState } from 'react';
import { Avatar, Image } from 'antd';
import { WarningOutlined, CheckOutlined } from '@ant-design/icons';
import copyIcon from '@/assets/icons/copy.svg';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, Provider } from '@/types';
import ProviderIcon from './ProviderIcon';
import styles from './chat.module.css';
import dayjs from 'dayjs';

interface Props {
  message: ChatMessage;
  provider: Provider;
  mobile?: boolean;
}

type Block =
  | { type: 'text'; value: string }
  | { type: 'tool_use'; name: string; body: string; result?: string }
  | { type: 'tool_group'; items: Array<{ name: string; body: string; result?: string }> }
  | { type: 'thinking'; value: string };

function basenameLike(filePath: string) {
  const text = String(filePath || '').trim();
  if (!text) return '';
  const normalized = text.replace(/[?#].*$/, '').split('\n')[0].trim();
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

function detectReadLabelFromCommand(command: string) {
  const text = String(command || '');
  const pathMatch = text.match(/["']([^"']+\.[a-zA-Z0-9_-]+)["']/);
  if (pathMatch?.[1] && /(?:^|\s)(cat|sed|nl|head|tail|less|more|bat|rg)\b/.test(text)) {
    return `Read ${basenameLike(pathMatch[1])}`;
  }
  return '';
}

function getToolItemLabel(name: string, body: string, result?: string) {
  if (name === 'Read') return `Read ${basenameLike(body)}`;
  if (name === 'Write') return `Wrote ${basenameLike(body)}`;
  if (name === 'Edit') return `Edited ${basenameLike(body)}`;
  if (name === 'Terminal') {
    const readLabel = detectReadLabelFromCommand(body);
    if (readLabel) return readLabel;
    const cmdLine = String(body || '').split('\n')[0].trim();
    if (/npm\s+run\s+([^\s]+)/.test(cmdLine)) return `Ran npm run ${cmdLine.match(/npm\s+run\s+([^\s]+)/)?.[1] || ''}`.trim();
    if (/node\s+--test\b/.test(cmdLine)) return 'Ran tests';
    if (/git\s+diff\b/.test(cmdLine)) return 'Checked git diff';
    const firstOutput = String(result || '').split('\n').map((line) => line.trim()).find(Boolean);
    if (firstOutput) return firstOutput.length > 64 ? firstOutput.slice(0, 64) + '...' : firstOutput;
    return cmdLine.length > 64 ? cmdLine.slice(0, 64) + '...' : (cmdLine || 'Ran command');
  }
  return name;
}

function getToolGroupSummary(items: Array<{ name: string; body: string; result?: string }>) {
  let readCount = 0;
  let editCount = 0;
  let commandCount = 0;

  items.forEach((item) => {
    const label = getToolItemLabel(item.name, item.body, item.result);
    if (label.startsWith('Read ')) {
      readCount += 1;
      return;
    }
    if (label.startsWith('Edited ') || label.startsWith('Wrote ')) {
      editCount += 1;
      return;
    }
    commandCount += 1;
  });

  const parts: string[] = [];
  if (readCount > 0) parts.push(`Explored ${readCount} file${readCount > 1 ? 's' : ''}`);
  if (editCount > 0) parts.push(`Edited ${editCount} file${editCount > 1 ? 's' : ''}`);
  if (commandCount > 0) parts.push(`ran ${commandCount} command${commandCount > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(', ') : `${items.length} actions`;
}

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

function mergeAdjacentToolBlocks(blocks: Block[]): Block[] {
  const merged: Block[] = [];
  let toolBuffer: Array<{ name: string; body: string; result?: string }> = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      merged.push({ type: 'tool_use', ...toolBuffer[0] });
    } else {
      merged.push({ type: 'tool_group', items: toolBuffer });
    }
    toolBuffer = [];
  };

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolBuffer.push(block);
      continue;
    }
    flushTools();
    merged.push(block);
  }
  flushTools();
  return merged;
}

/** 解析 :::tool{name="xxx"} 和 :::tool-result 格式 */
function parseContent(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split('\n');
  let i = 0;
  let textBuf: string[] = [];

  const flushText = () => {
    const t = textBuf.join('\n').trim();
    if (t) blocks.push({ type: 'text', value: t });
    textBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const toolMatch = line.match(/^:::tool\{name="([^"]+)"\}$/);
    if (toolMatch) {
      flushText();
      const name = toolMatch[1];
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== ':::') { bodyLines.push(lines[i]); i++; }
      i++; // skip :::

      // 检查紧接着是否有 :::tool-result
      let result: string | undefined;
      // 跳过空行
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i < lines.length && lines[i] === ':::tool-result') {
        const resultLines: string[] = [];
        i++;
        while (i < lines.length && lines[i] !== ':::') { resultLines.push(lines[i]); i++; }
        i++; // skip :::
        result = resultLines.join('\n').trim();
      }

      blocks.push({ type: 'tool_use', name, body: bodyLines.join('\n').trim(), result });
      continue;
    }
    // :::thinking
    if (line === ':::thinking') {
      flushText();
      const thinkLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== ':::') { thinkLines.push(lines[i]); i++; }
      i++;
      blocks.push({ type: 'thinking', value: thinkLines.join('\n').trim() });
      continue;
    }

    // 兼容旧格式
    const old = line.match(/^\[Tool: ([^\]]+)\]$/);
    if (old) { flushText(); blocks.push({ type: 'tool_use', name: old[1], body: '' }); i++; continue; }
    if (line === '[Tool Result]') { i++; continue; }
    if (line === ':::tool-result') { i++; while (i < lines.length && lines[i] !== ':::') i++; i++; continue; }

    // Codex 指令: ::git-stage{cwd="..."} ::git-commit{cwd="..."} ::archive{...}
    const codexDirective = line.match(/^::([a-z-]+)\{(.+)\}$/);
    if (codexDirective) {
      flushText();
      const cmd = codexDirective[1]; // git-stage, git-commit, git-push, etc.
      const attrs = codexDirective[2]; // cwd="..." branch="..."
      const cwdMatch = attrs.match(/cwd="([^"]+)"/);
      const branchMatch = attrs.match(/branch="([^"]+)"/);
      let body = cmd;
      if (cwdMatch) body += '\n# cwd: ' + cwdMatch[1];
      if (branchMatch) body += '\n# branch: ' + branchMatch[1];
      blocks.push({ type: 'tool_use', name: 'Git', body });
      i++;
      continue;
    }

    textBuf.push(line);
    i++;
  }
  flushText();
  if (blocks.length === 0) blocks.push({ type: 'text', value: content });
  return mergeAdjacentToolBlocks(blocks);
}

/** 判断是否为错误消息 */
function isErrorMessage(c: string): boolean {
  const t = c.trim();
  return t.startsWith('API Error:') || t.startsWith('Error:') || (t.startsWith('{') && t.includes('"error"'));
}

/** 尝试解析 TodoWrite JSON */
function parseTodos(body: string): Array<{ content: string; status: string }> | null {
  try {
    const arr = JSON.parse(body);
    if (Array.isArray(arr) && arr.length > 0 && arr[0].content) return arr;
  } catch { /* not json */ }
  return null;
}

function parseAttachedImageBlock(content: string) {
  const text = String(content || '');
  const lines = text.split('\n');
  if (lines.length < 3 || lines[0].trim() !== 'Attached image files:') {
    return {
      text,
      imagePaths: [] as string[]
    };
  }

  const imagePaths: string[] = [];
  let index = 1;
  while (index < lines.length && lines[index].trim().startsWith('- ')) {
    imagePaths.push(lines[index].trim().slice(2).trim());
    index += 1;
  }
  if (index < lines.length && lines[index].trim() === 'Please inspect these local image files directly when answering.') {
    index += 1;
  }
  while (index < lines.length && lines[index].trim() === '') index += 1;

  return {
    text: lines.slice(index).join('\n').trim(),
    imagePaths
  };
}

function toServedImageUrl(filePath: string) {
  return `/v0/webui/chat/attachments?path=${encodeURIComponent(filePath)}`;
}

const ImageGallery = ({ images }: { images: string[] }) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  return (
    <Image.PreviewGroup items={images}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 10
      }}>
        {images.map((src, index) => (
          <Image
            key={`${src}-${index}`}
            src={src}
            alt={`chat-image-${index + 1}`}
            width={112}
            style={{
              maxWidth: '100%',
              height: 112,
              borderRadius: 12,
              border: '1px solid #e5e7eb',
              background: '#fff',
              objectFit: 'cover'
            }}
          />
        ))}
      </div>
    </Image.PreviewGroup>
  );
};

/** Thinking 折叠块 */
const ThinkingBlock = ({ value }: { value: string }) => {
  const [expanded, setExpanded] = useState(false);
  const lastLine = value.split('\n').filter(l => l.trim()).pop() || '';
  return (
    <div className={styles.thinkingBlock} onClick={() => setExpanded(!expanded)}>
      <div className={styles.thinkingHeader}>
        <span style={{ fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>
        <span>Thinking</span>
        {!expanded && <span className={styles.thinkingPreview}>{lastLine.slice(0, 60)}</span>}
      </div>
      {expanded && <div className={styles.thinkingBody}>{value}</div>}
    </div>
  );
};

/** 工具图标映射 */
const toolIcons: Record<string, string> = {
  Bash: '$ ',
  Terminal: '$ ',
  Read: '📄 ',
  Write: '📝 ',
  Edit: '✏️ ',
  Grep: '🔍 ',
  Glob: '📂 ',
  TodoWrite: '☑ ',
  WebFetch: '🌐 ',
  Task: '🤖 ',
  Git: '⑂ ',
};

/** TodoWrite 渲染 */
const TodoList = ({ items }: { items: Array<{ content: string; status: string }> }) => (
  <div className={styles.toolBody}>
    {items.map((item, i) => (
      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 13 }}>
        <input type="checkbox" checked={item.status === 'completed'} readOnly
          style={{ accentColor: item.status === 'in_progress' ? '#faad14' : undefined }} />
        <span style={{
          textDecoration: item.status === 'completed' ? 'line-through' : 'none',
          color: item.status === 'completed' ? '#999' : item.status === 'in_progress' ? '#1890ff' : '#333'
        }}>{item.content}</span>
      </div>
    ))}
  </div>
);

/** Tool 块渲染（含 result） */
const ToolBlock = ({ name, body, result }: { name: string; body: string; result?: string }) => {
  const icon = toolIcons[name] || '🔧 ';
  const cleanedResult = name === 'Terminal' ? cleanTerminalResultText(result || '') : (result || '');

  // TodoWrite 特殊渲染
  if (name === 'TodoWrite') {
    const todos = parseTodos(body);
    if (todos) {
      return (
        <div className={styles.toolBlock}>
          <div className={styles.toolHeader}>{icon}Todo</div>
          <TodoList items={todos} />
        </div>
      );
    }
  }

  // Bash/Terminal/Git 渲染为代码块 + 输出
  if ((name === 'Bash' || name === 'Terminal' || name === 'Git') && body) {
    return <ShellToolBlock name={name} icon={icon} body={body} rawResult={result || ''} cleanedResult={cleanedResult} />;
  }

  // 通用渲染
  return (
    <div className={styles.toolBlock}>
      <div className={styles.toolHeader}>{icon}{name}</div>
      {body && <div className={styles.toolBody}><code style={{ fontSize: 12, wordBreak: 'break-all' }}>{body}</code></div>}
      {cleanedResult && (
        <div className={styles.toolBody} style={{ borderTop: '1px solid #e8e8e8' }}>
          <pre style={{ margin: 0, fontSize: 11, color: '#666', whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto' }}>{cleanedResult}</pre>
        </div>
      )}
    </div>
  );
};

const ShellToolBlock = ({
  name,
  icon,
  body,
  rawResult,
  cleanedResult
}: {
  name: string;
  icon: string;
  body: string;
  rawResult: string;
  cleanedResult: string;
}) => {
  const [expanded, setExpanded] = useState(false);
  const shellCommand = String(body || '').split('\n').find((line) => !line.startsWith('# cwd:')) || String(body || '').split('\n')[0] || '';
  const durationLabel = extractShellDurationLabel(rawResult);
  const shellHeader = `已运行命令${durationLabel ? ` (${durationLabel})` : ''}`;

  return (
    <div className={`${styles.toolBlock} ${name === 'Terminal' ? styles.shellBlock : ''}`}>
      <button type="button" className={styles.shellCollapseHeader} onClick={() => setExpanded((current) => !current)}>
        <span className={styles.shellCollapseTitle}>{shellHeader}</span>
        <span className={styles.shellCollapseCommand}>{shellCommand}</span>
        <span className={styles.shellCollapseChevron}>{expanded ? '⌄' : '›'}</span>
      </button>
      {expanded && (
        <>
          <div className={styles.toolHeader}>{name === 'Terminal' ? 'Shell' : `${icon}${name === 'Git' ? 'Git' : 'Terminal'}`}</div>
          <div className={styles.shellCommandBlock}>
            <pre className={styles.shellCommandCode}>{`$ ${shellCommand}`}</pre>
          </div>
          {cleanedResult && (
            <div className={styles.shellOutputBlock}>
              <pre className={styles.shellOutputCode}>{cleanedResult}</pre>
              <div className={styles.shellStatus}>✓ 成功</div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const ToolGroupBlock = ({ items }: { items: Array<{ name: string; body: string; result?: string }> }) => {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolGroupSummary(items);

  return (
    <div className={styles.toolGroupBlock}>
      <button type="button" className={styles.toolGroupHeader} onClick={() => setExpanded((current) => !current)}>
        <span>{summary}</span>
        <span className={styles.toolGroupChevron}>{expanded ? '⌄' : '›'}</span>
      </button>
      {expanded && (
        <div className={styles.toolGroupList}>
          {items.map((item, index) => {
            const label = getToolItemLabel(item.name, item.body, item.result);
            return (
              <div key={`${item.name}-${index}`} className={styles.toolGroupItem}>
                <div className={styles.toolGroupItemLabel}>{label}</div>
                {item.result ? (
                  <div className={styles.toolGroupItemResult}>
                    <pre>{item.result}</pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** 复制按钮 */
const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button className={styles.actionBtn} onClick={handleCopy} title="复制">
      {copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <img src={copyIcon} alt="copy" style={{ width: 14, height: 14 }} />}
    </button>
  );
};

const formatMessageTime = (timestamp?: string | number) => {
  if (timestamp == null || timestamp === '') return '';
  const date = dayjs(timestamp);
  if (!date.isValid()) return '';
  return date.format('HH:mm');
};

const MessageBubble = ({ message, provider, mobile = false }: Props) => {
  const isUser = message.role === 'user';
  const timeLabel = formatMessageTime(message.timestamp);
  const [metaVisible, setMetaVisible] = useState(false);
  const parsedAttachmentBlock = useMemo(() => parseAttachedImageBlock(message.content), [message.content]);
  const inlineImages = useMemo(() => (Array.isArray(message.images) ? message.images : []), [message.images]);
  const persistedImages = useMemo(
    () => parsedAttachmentBlock.imagePaths.map(toServedImageUrl),
    [parsedAttachmentBlock.imagePaths]
  );
  const renderedImages = inlineImages.length > 0 ? inlineImages : persistedImages;
  const messageText = renderedImages.length > 0 ? parsedAttachmentBlock.text : message.content;
  const metaRowClassName = `${styles.messageMetaRow} ${isUser ? styles.messageMetaRowUser : styles.messageMetaRowAssistant} ${metaVisible ? styles.messageMetaRowVisible : ''}`;

  const handleMessageTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!mobile) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, label, img, video, [role="button"], .ant-image, .ant-image-preview-root')) {
      return;
    }
    setMetaVisible((current) => !current);
  };

  if (isUser) {
    return (
      <div className={`${styles.messageRow} ${styles.messageRowUser}`}>
        <div className={`${styles.messageWrapper} ${styles.messageWrapperUser}`} onClick={handleMessageTap}>
          <div className={styles.bubbleUser}>
            <ImageGallery images={renderedImages} />
            {messageText || (renderedImages.length > 0 ? '已附加图片' : '')}
          </div>
          <div className={metaRowClassName}>
            {timeLabel ? <span className={styles.messageTime}>{timeLabel}</span> : <span />}
            <CopyButton text={messageText || message.content} />
          </div>
        </div>
      </div>
    );
  }

  if (isErrorMessage(message.content)) {
    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        <Avatar size={32} className={styles.avatarAi} style={{ background: '#fff2f0', border: '1px solid #ffccc7' }}>
          <WarningOutlined style={{ color: '#cf1322', fontSize: 16 }} />
        </Avatar>
        <div className={styles.bubbleError}>{message.content}</div>
      </div>
    );
  }

  if (message.pending) {
    const thinkingPreview = (() => {
      const raw = String(message.content || '');
      const match = raw.match(/:::thinking\n([\s\S]*?)\n:::/);
      if (!match || !match[1]) return '';
      const lines = match[1].split('\n').map((line) => line.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      return lastLine.length > 72 ? `${lastLine.slice(0, 72)}...` : lastLine;
    })();

    return (
      <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
        <Avatar size={32} className={styles.avatarAi}>
          <ProviderIcon provider={provider} size={18} />
        </Avatar>
        <div className={`${styles.messageWrapper} ${styles.messageWrapperAssistant}`} onClick={handleMessageTap}>
          <div className={`${styles.bubbleAssistant} ${styles.bubbleAssistantPending}`}>
            <span className={styles.srOnly}>{message.statusText || 'AI 正在回复'}</span>
            <div className={styles.pendingShell} aria-hidden="true">
              <div className={styles.pendingHeroRow}>
                <div className={styles.pendingBadge}>
                  <span className={styles.pendingBadgeSpinner} />
                </div>
                <div className={styles.pendingStatusStack}>
                  <div className={styles.pendingStatusLabel}>{message.statusText || 'AI 正在回复'}</div>
                  <div className={styles.pendingSubLabel}>思考中，正在组织上下文和工具结果</div>
                </div>
              </div>
              <div className={styles.pendingPulseBar} aria-hidden="true">
                <span />
              </div>
              <div className={styles.pendingTopRow}>
                <div className={styles.pendingOrb}>
                  <span className={styles.pendingOrbCore} />
                  <span className={styles.pendingOrbRing} />
                </div>
                <div className={styles.pendingWave}>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className={styles.pendingLines}>
                <span className={styles.pendingLine} />
                <span className={`${styles.pendingLine} ${styles.pendingLineShort}`} />
                <span className={`${styles.pendingLine} ${styles.pendingLineTiny}`} />
              </div>
              {thinkingPreview ? (
                <div className={styles.pendingThinkingPreview}>{thinkingPreview}</div>
              ) : null}
            </div>
            <div className={styles.typingDots} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className={styles.pendingGlow} aria-hidden="true" />
            <div className={styles.pendingGrid} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className={metaRowClassName}>
            <CopyButton text={message.content || ''} />
            {timeLabel ? <span className={styles.messageTime}>{timeLabel}</span> : <span />}
          </div>
        </div>
      </div>
    );
  }

  const blocks = useMemo(() => parseContent(messageText || message.content), [messageText, message.content]);

  return (
    <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
      <Avatar size={32} className={styles.avatarAi}>
        <ProviderIcon provider={provider} size={18} />
      </Avatar>
        <div className={`${styles.messageWrapper} ${styles.messageWrapperAssistant}`} onClick={handleMessageTap}>
          <div className={styles.bubbleAssistant}>
            <ImageGallery images={renderedImages} />
            {blocks.map((block, idx) => {
              if (block.type === 'thinking') return <ThinkingBlock key={idx} value={block.value} />;
              if (block.type === 'tool_use') return <ToolBlock key={idx} name={block.name} body={block.body} result={block.result} />;
              if (block.type === 'tool_group') return <ToolGroupBlock key={idx} items={block.items} />;
              return <ReactMarkdown key={idx} remarkPlugins={[remarkGfm]}>{block.value}</ReactMarkdown>;
            })}
          </div>
          <div className={metaRowClassName}>
            <CopyButton text={messageText || message.content} />
            {timeLabel ? <span className={styles.messageTime}>{timeLabel}</span> : <span />}
          </div>
        </div>
      </div>
  );
};

export default memo(MessageBubble);
