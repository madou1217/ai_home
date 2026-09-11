import { useCallback, useRef, useState } from 'react';
import { message as toast } from 'antd';
import type { ChatRuntimeAttachmentUpload } from '@/chat-runtime';

import { CHAT_ATTACHMENT_LIMITS, readChatAttachment } from '@/components/chat/attachment-files';

export const MAX_COMPOSER_ATTACHMENTS = CHAT_ATTACHMENT_LIMITS.maxFiles;
export const COMPOSER_ATTACHMENT_LIMIT_MESSAGE = `每次最多附加 ${CHAT_ATTACHMENT_LIMITS.maxFiles} 个文件，总大小不超过 ${Math.round(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / 1048576)} MB`;

export interface PendingComposerAttachment extends ChatRuntimeAttachmentUpload {
  readonly key: string;
  readonly size: number;
}

export interface ComposerAttachmentsController {
  readonly items: readonly PendingComposerAttachment[];
  readonly addFiles: (files: readonly File[]) => Promise<void>;
  readonly remove: (key: string) => void;
  readonly clear: () => void;
}

export function useComposerAttachments(): ComposerAttachmentsController {
  const [items, setItems] = useState<readonly PendingComposerAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const pending = useRef(Promise.resolve());
  const generation = useRef(0);
  const addFiles = useCallback((files: readonly File[]): Promise<void> => {
    const batchGeneration = generation.current;
    pending.current = pending.current.then(async () => {
      const results = await Promise.allSettled(files.map(readPendingAttachment));
      if (batchGeneration !== generation.current) return;
      const next = [...itemsRef.current];
      let bytes = next.reduce((total, item) => total + item.size, 0);
      for (const result of results) {
        if (result.status === 'rejected') {
          toast.warning(String(result.reason?.message || '附件读取失败'));
          continue;
        }
        if (next.length >= MAX_COMPOSER_ATTACHMENTS
            || bytes + result.value.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
          toast.warning(COMPOSER_ATTACHMENT_LIMIT_MESSAGE);
          break;
        }
        bytes += result.value.size;
        next.push(result.value);
      }
      itemsRef.current = next;
      setItems(next);
    }).catch(() => { toast.error('附件读取失败'); });
    return pending.current;
  }, []);

  const remove = useCallback((key: string): void => {
    const next = itemsRef.current.filter((item) => item.key !== key);
    itemsRef.current = next;
    setItems(next);
  }, []);
  const clear = useCallback((): void => {
    generation.current += 1;
    itemsRef.current = [];
    setItems([]);
  }, []);
  return { items, addFiles, remove, clear };
}

async function readPendingAttachment(file: File): Promise<PendingComposerAttachment> {
  const attachment = await readChatAttachment(file);
  return { key: createAttachmentKey(file), ...attachment };
}

function createAttachmentKey(file: File): string {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  return `${identity}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}
