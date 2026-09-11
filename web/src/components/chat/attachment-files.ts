import limits from '../../../../contracts/chat-attachments.json';

export { limits as CHAT_ATTACHMENT_LIMITS };
export const CHAT_ATTACHMENT_ACCEPT = [
  ...limits.imageTypes,
  ...limits.videoTypes,
  'text/*',
  ...limits.textExtensions.map((extension) => `.${extension}`),
  ...Object.keys(limits.videoExtensionTypes).map((extension) => `.${extension}`),
].join(',');

export interface ChatDocumentAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface ReadChatAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly size: number;
  readonly document?: ChatDocumentAttachment;
}

type AttachmentKind = 'image' | 'video' | 'document';

function megabytes(bytes: number): number {
  return Math.round(bytes / 1048576);
}

export function resolveChatAttachmentKind(name: string, mimeType: string): AttachmentKind | '' {
  const extension = name.split('.').pop()?.toLowerCase() || '';
  if ((limits.imageTypes as readonly string[]).includes(mimeType)) return 'image';
  if ((limits.videoTypes as readonly string[]).includes(mimeType)) return 'video';
  if (mimeType.startsWith('text/') || (limits.textExtensions as readonly string[]).includes(extension)) return 'document';
  const extensionVideoMime = (limits.videoExtensionTypes as Record<string, string>)[extension];
  if (extensionVideoMime && (!mimeType || mimeType === 'application/octet-stream')) return 'video';
  return '';
}

export function assertChatAttachmentSize(name: string, kind: AttachmentKind, size: number): void {
  const maxBytes = kind === 'image'
    ? limits.maxImageBytes
    : kind === 'video' ? limits.maxVideoBytes : limits.maxDocumentBytes;
  if (size > maxBytes) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文本文件';
    throw new Error(`${name}：${label}不能超过 ${megabytes(maxBytes)} MB`);
  }
  if (kind === 'image' && size === 0) throw new Error(`${name}：图片为空`);
  if (kind === 'video' && size === 0) throw new Error(`${name}：视频为空`);
}

export async function readChatAttachment(file: File): Promise<ReadChatAttachment> {
  const name = file.name || '附件';
  const extension = name.split('.').pop()?.toLowerCase() || '';
  const kind = resolveChatAttachmentKind(name, file.type);
  if (!kind) {
    throw new Error(`${name}：支持图片、视频、Markdown、文本、代码及 JSON/CSV 等文本数据文件`);
  }
  assertChatAttachmentSize(name, kind, file.size);
  let document: ChatDocumentAttachment | undefined;
  const mimeType = kind === 'image'
    ? file.type
    : kind === 'video'
      ? (file.type || (limits.videoExtensionTypes as Record<string, string>)[extension] || 'video/mp4')
      : extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain';
  if (kind === 'document') {
    const bytes = await readFile(file, 'arrayBuffer') as ArrayBuffer;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${name}：请使用 UTF-8 编码的文本文件`); }
    if (Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || (code >= 14 && code <= 31);
    })) throw new Error(`${name}：文件包含二进制内容`);
    document = { name, mimeType, text };
  }
  const rawUrl = await readFile(file, 'dataUrl') as string;
  return { name, mimeType, size: file.size, dataUrl: `data:${mimeType};base64,${rawUrl.split(',')[1]}`, document };
}

function readFile(file: File, format: 'dataUrl' | 'arrayBuffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result === null ? reject(new Error(`${file.name}：读取失败`)) : resolve(reader.result);
    reader.onerror = () => reject(new Error(`${file.name}：读取失败`));
    if (format === 'dataUrl') reader.readAsDataURL(file);
    else reader.readAsArrayBuffer(file);
  });
}

export function appendDocumentText(content: string, documents: readonly ChatDocumentAttachment[] = []): string {
  return [content.trim(), ...documents.map(({ name, text }) => (
    `附件 ${JSON.stringify(name)}：\n${text}\n（附件结束）`
  ))].filter(Boolean).join('\n\n');
}
