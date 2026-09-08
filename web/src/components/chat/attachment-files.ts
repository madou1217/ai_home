import limits from '../../../../contracts/chat-attachments.json';

export { limits as CHAT_ATTACHMENT_LIMITS };
export const CHAT_ATTACHMENT_ACCEPT = [
  ...limits.imageTypes, 'text/*', ...limits.textExtensions.map((extension) => `.${extension}`),
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

export async function readChatAttachment(file: File): Promise<ReadChatAttachment> {
  const name = file.name || '附件';
  const image = limits.imageTypes.includes(file.type);
  const extension = name.split('.').pop()?.toLowerCase() || '';
  if (!image && !file.type.startsWith('text/') && !limits.textExtensions.includes(extension)) {
    throw new Error(`${name}：支持图片、Markdown、文本、代码及 JSON/CSV 等文本数据文件`);
  }
  const maxBytes = image ? limits.maxImageBytes : limits.maxDocumentBytes;
  if (file.size > maxBytes) throw new Error(`${name}：${image ? '图片不能超过 10 MB' : '文本文件不能超过 1 MB'}`);
  if (image && file.size === 0) throw new Error(`${name}：图片为空`);
  const bytes = await readFile(file, 'arrayBuffer') as ArrayBuffer;
  let document: ChatDocumentAttachment | undefined;
  const mimeType = image ? file.type : extension === 'md' || extension === 'markdown' ? 'text/markdown' : 'text/plain';
  if (!image) {
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
