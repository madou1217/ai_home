import { useCallback, useRef } from 'react';
import { message } from 'antd';
import { CHAT_ATTACHMENT_LIMITS, readChatAttachment, type ChatDocumentAttachment } from './attachment-files';

interface Options {
  images: string[];
  documents: ChatDocumentAttachment[];
  onImagesChange?: (images: string[]) => void;
  onDocumentsChange?: (documents: ChatDocumentAttachment[]) => void;
}

export function useChatFileInput(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(Promise.resolve());
  return useCallback((files: readonly File[]) => {
    // Serialize batches so simultaneous drops/selects cannot overwrite each other.
    pending.current = pending.current.then(async () => {
      const results = await Promise.allSettled(files.map(readChatAttachment));
      const current = latest.current;
      const images = current.images.slice();
      const documents = current.documents.slice();
      let bytes = images.reduce((total, url) => total + Math.ceil((url.split(',')[1]?.length || 0) * 3 / 4), 0)
        + documents.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0);
      for (const result of results) {
        if (result.status === 'rejected') {
          message.warning(String(result.reason?.message || '附件读取失败'));
          continue;
        }
        const attachment = result.value;
        if (images.length + documents.length >= CHAT_ATTACHMENT_LIMITS.maxFiles
            || bytes + attachment.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
          message.warning('每次最多附加 8 个文件，总大小不超过 20 MB');
          break;
        }
        bytes += attachment.size;
        if (attachment.document) documents.push(attachment.document);
        else images.push(attachment.dataUrl);
      }
      latest.current = { ...current, images, documents };
      current.onImagesChange?.(images);
      current.onDocumentsChange?.(documents);
    }).catch(() => { message.error('附件读取失败'); });
    return pending.current;
  }, []);
}
