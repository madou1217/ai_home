import { memo, useState } from 'react';
import { DownOutlined, FileTextOutlined, RightOutlined } from '@ant-design/icons';
import styles from './message-bubble.module.css';

// 服务端 formatChatDocumentBlock / 前端 appendDocumentText 的信封：
//   附件 "<json 名称>"：\n<正文>\n（附件结束）
// 已发送的用户消息里如果原样显示，长文本粘贴会把整个气泡撑成一屏全文；
// 这里只做展示层拆解，复制/重试仍使用原始 content。
const DOCUMENT_BLOCK = /(?:^|\n\n)附件 ("(?:[^"\\]|\\.)*")：\n([\s\S]*?)\n（附件结束）/g;
const PREVIEW_CHARS = 160;

// Work 模式只把路径交给 agent 自己读（appendDocumentPathsToPrompt）：
//   Attached document files:\n- /abs/path\nRead these local document files when answering.
const DOCUMENT_PATH_BLOCK = /(?:^|\n)Attached document files:\n((?:- [^\n]+\n?)+)Read these local document files when answering\./;

export interface UserDocumentBlock {
  readonly name: string;
  /** 内联正文；Work 模式只有路径，没有正文。 */
  readonly text?: string;
  readonly path?: string;
}

export function splitUserDocumentBlocks(content: string): { text: string; documents: UserDocumentBlock[] } {
  const value = String(content || '');
  const documents: UserDocumentBlock[] = [];
  const text = value.replace(DOCUMENT_BLOCK, (_match, rawName: string, body: string) => {
    documents.push({ name: parseName(rawName), text: body });
    return '';
  }).replace(DOCUMENT_PATH_BLOCK, (_match, list: string) => {
    list.split('\n').map((line) => line.replace(/^- /, '').trim()).filter(Boolean).forEach((path) => {
      documents.push({ name: path.split(/[\\/]/).pop() || path, path });
    });
    return '';
  }).trim();
  return documents.length > 0 ? { text, documents } : { text: value, documents };
}

function parseName(rawName: string): string {
  try {
    return String(JSON.parse(rawName));
  } catch {
    return rawName.slice(1, -1);
  }
}

function displayName(name: string): string {
  // 上传落盘会加 "<uuid>-" 前缀，展示时去掉。
  return name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
}

function sizeLabel(text: string | undefined): string {
  if (text === undefined) return '本地文件';
  const chars = Array.from(text).length;
  return chars >= 10000 ? `${(chars / 1000).toFixed(1)}k 字符` : `${chars} 字符`;
}

const UserDocumentCard = memo(function UserDocumentCard({ document }: { document: UserDocumentBlock }) {
  const [open, setOpen] = useState(false);
  const name = displayName(document.name);
  const body = document.text;
  const preview = body === undefined ? document.path || '' : body.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  const expandable = body !== undefined;
  return (
    <div className={styles.userDocumentCard} data-open={open}>
      <button
        type="button"
        className={styles.userDocumentHeader}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <FileTextOutlined className={styles.userDocumentIcon} aria-hidden />
        <span className={styles.userDocumentMeta}>
          <strong title={name}>{name}</strong>
          <small>{sizeLabel(document.text)}{open ? '' : preview ? ` · ${preview}` : ''}</small>
        </span>
        {expandable ? (open ? <DownOutlined aria-hidden /> : <RightOutlined aria-hidden />) : null}
      </button>
      {open && expandable ? <pre className={styles.userDocumentBody}>{body}</pre> : null}
    </div>
  );
});

export const UserDocumentAttachments = memo(function UserDocumentAttachments(
  { documents }: { documents: readonly UserDocumentBlock[] },
) {
  if (documents.length === 0) return null;
  return (
    <div className={styles.userDocumentList} aria-label="已发送附件">
      {documents.map((document, index) => (
        <UserDocumentCard key={`${document.name}-${index}`} document={document} />
      ))}
    </div>
  );
});
