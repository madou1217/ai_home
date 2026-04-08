import { useState } from 'react';
import { Avatar } from 'antd';
import { UserOutlined, WarningOutlined, CopyOutlined, CheckOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, Provider } from '@/types';
import ProviderIcon from './ProviderIcon';
import styles from './chat.module.css';

interface Props {
  message: ChatMessage;
  provider: Provider;
}

type Block =
  | { type: 'text'; value: string }
  | { type: 'tool_use'; name: string; body: string; result?: string };

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
  return blocks;
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
    return (
      <div className={styles.toolBlock}>
        <div className={styles.toolHeader}>{icon}{name === 'Git' ? 'Git' : 'Terminal'}</div>
        <div className={styles.toolBody}>
          <pre className={styles.codeBlock}>{body}</pre>
        </div>
        {result && (
          <div className={styles.toolBody} style={{ borderTop: '1px solid #e8e8e8' }}>
            <pre style={{ margin: 0, fontSize: 11, color: '#666', whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto' }}>{result}</pre>
          </div>
        )}
      </div>
    );
  }

  // 通用渲染
  return (
    <div className={styles.toolBlock}>
      <div className={styles.toolHeader}>{icon}{name}</div>
      {body && <div className={styles.toolBody}><code style={{ fontSize: 12, wordBreak: 'break-all' }}>{body}</code></div>}
      {result && (
        <div className={styles.toolBody} style={{ borderTop: '1px solid #e8e8e8' }}>
          <pre style={{ margin: 0, fontSize: 11, color: '#666', whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto' }}>{result}</pre>
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
      {copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
    </button>
  );
};

const MessageBubble = ({ message, provider }: Props) => {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className={`${styles.messageRow} ${styles.messageRowUser}`}>
        <div>
          <div className={styles.bubbleUser}>{message.content}</div>
          <div className={styles.messageActions} style={{ justifyContent: 'flex-end' }}>
            <CopyButton text={message.content} />
          </div>
        </div>
        <Avatar size={32} icon={<UserOutlined />} className={styles.avatarUser} />
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

  const blocks = parseContent(message.content);

  return (
    <div className={`${styles.messageRow} ${styles.messageRowAssistant}`}>
      <Avatar size={32} className={styles.avatarAi}>
        <ProviderIcon provider={provider} size={18} />
      </Avatar>
      <div>
        <div className={styles.bubbleAssistant}>
          {blocks.map((block, idx) => {
            if (block.type === 'tool_use') {
              return <ToolBlock key={idx} name={block.name} body={block.body} result={block.result} />;
            }
            return <ReactMarkdown key={idx} remarkPlugins={[remarkGfm]}>{block.value}</ReactMarkdown>;
          })}
        </div>
        <div className={styles.messageActions}>
          <CopyButton text={message.content} />
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;
