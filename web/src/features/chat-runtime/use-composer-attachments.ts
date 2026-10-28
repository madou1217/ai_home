import { useCallback, useRef, useState } from 'react';
import { message as toast } from 'antd';
import type { ChatRuntimeAttachmentUpload } from '@/chat-runtime';

import {
  CHAT_ATTACHMENT_LIMITS,
  readChatAttachment,
  readPastedTextAttachment,
} from '@/components/chat/attachment-files';
import type { ChatDocumentAttachment } from '@/components/chat/attachment-files';

export const MAX_COMPOSER_ATTACHMENTS = CHAT_ATTACHMENT_LIMITS.maxFiles;
export const COMPOSER_ATTACHMENT_LIMIT_MESSAGE = `每次最多附加 ${CHAT_ATTACHMENT_LIMITS.maxFiles} 个文件，总大小不超过 ${Math.round(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / 1048576)} MB`;
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 50;

export interface PendingComposerAttachment extends ChatRuntimeAttachmentUpload {
  readonly key: string;
  readonly size: number;
  readonly document?: ChatDocumentAttachment;
}

export interface ComposerAttachmentsController {
  readonly items: readonly PendingComposerAttachment[];
  readonly addFiles: (files: readonly File[]) => Promise<void>;
  readonly addPastedText: (text: string) => Promise<void>;
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

  const addPastedText = useCallback((text: string): Promise<void> => {
    const batchGeneration = generation.current;
    pending.current = pending.current.then(async () => {
      const result = await readPastedTextAttachment(text);
      if (batchGeneration !== generation.current) return;
      const next = [...itemsRef.current];
      const bytes = next.reduce((total, item) => total + item.size, 0);
      if (next.length >= MAX_COMPOSER_ATTACHMENTS
          || bytes + result.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
        toast.warning(COMPOSER_ATTACHMENT_LIMIT_MESSAGE);
        return;
      }
      next.push({ key: createAttachmentKey(new File([text], 'pasted-text.txt')), ...result });
      itemsRef.current = next;
      setItems(next);
    }).catch((error: unknown) => {
      toast.warning(String(error instanceof Error ? error.message : '粘贴文本读取失败'));
    });
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
  return { items, addFiles, addPastedText, remove, clear };
}

async function readPendingAttachment(file: File): Promise<PendingComposerAttachment> {
  const attachment = await readChatAttachment(file);
  return { key: createAttachmentKey(file), ...attachment };
}

function createAttachmentKey(file: File): string {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  return `${identity}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}
