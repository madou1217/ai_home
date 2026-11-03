import { useCallback, useRef, useState } from 'react';
import { message as toast } from 'antd';
import type { ChatRuntimeAttachmentUpload } from '@/chat-runtime';

import { CHAT_ATTACHMENT_LIMITS, readChatAttachment, type ChatDocumentAttachment } from '@/components/chat/attachment-files';

export const MAX_COMPOSER_ATTACHMENTS = CHAT_ATTACHMENT_LIMITS.maxFiles;
export const COMPOSER_ATTACHMENT_LIMIT_MESSAGE = `每次最多附加 ${CHAT_ATTACHMENT_LIMITS.maxFiles} 个文件，总大小不超过 ${Math.round(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / 1048576)} MB`;

export type PendingComposerAttachmentStatus = 'preparing' | 'ready' | 'uploading' | 'uploaded' | 'failed';

export interface PendingComposerAttachment extends ChatRuntimeAttachmentUpload {
  readonly key: string;
  readonly size: number;
  readonly file: File;
  readonly document?: ChatDocumentAttachment;
  readonly status: PendingComposerAttachmentStatus;
  readonly attachmentId?: string;
  readonly error?: string;
}

export interface ComposerAttachmentsController {
  readonly items: readonly PendingComposerAttachment[];
  readonly addFiles: (files: readonly File[]) => Promise<void>;
  readonly remove: (key: string) => void;
  readonly retry: (key: string) => Promise<void>;
  readonly setStatus: (keys: readonly string[], status: PendingComposerAttachmentStatus, error?: string) => void;
  readonly markUploaded: (uploads: readonly { key: string; attachmentId: string }[]) => void;
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
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - itemsRef.current.length);
    if (files.length > available) toast.warning(COMPOSER_ATTACHMENT_LIMIT_MESSAGE);
    const preparing = files.slice(0, available).map((file) => ({
      key: createAttachmentKey(file),
      name: file.name || '附件',
      mimeType: file.type || 'text/plain',
      dataUrl: '',
      size: file.size,
      file,
      status: 'preparing' as const,
    }));
    if (preparing.length > 0) {
      const next = [...itemsRef.current, ...preparing].slice(0, MAX_COMPOSER_ATTACHMENTS);
      itemsRef.current = next;
      setItems(next);
    }
    pending.current = pending.current.then(async () => {
      const results = await Promise.allSettled(preparing.map((item) => readPendingAttachment(item.file)));
      if (batchGeneration !== generation.current) return;
      const next = [...itemsRef.current];
      let bytes = next.reduce((total, item) => total + (item.status === 'preparing' ? 0 : item.size), 0);
      for (const [index, result] of results.entries()) {
        const target = preparing[index];
        const targetIndex = next.findIndex((item) => item.key === target.key);
        if (targetIndex < 0) continue;
        if (result.status === 'rejected') {
          const error = String(result.reason?.message || '附件读取失败');
          next[targetIndex] = { ...target, status: 'failed', error };
          toast.warning(error);
          continue;
        }
        if (bytes + result.value.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
          next[targetIndex] = { ...target, status: 'failed', error: COMPOSER_ATTACHMENT_LIMIT_MESSAGE };
          toast.warning(COMPOSER_ATTACHMENT_LIMIT_MESSAGE);
          continue;
        }
        bytes += result.value.size;
        next[targetIndex] = { ...result.value, key: target.key, file: target.file, status: 'ready' };
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
  const retry = useCallback((key: string): Promise<void> => {
    const current = itemsRef.current.find((item) => item.key === key);
    if (!current) return Promise.resolve();
    const preparing = itemsRef.current.map((item) => item.key === key
      ? { ...item, status: 'preparing' as const, error: undefined }
      : item);
    itemsRef.current = preparing;
    setItems(preparing);
    pending.current = pending.current.then(async () => {
      try {
        const attachment = await readPendingAttachment(current.file);
        const otherItems = itemsRef.current.filter((item) => item.key !== key);
        const otherBytes = otherItems.reduce((total, item) => total + (item.status === 'preparing' ? 0 : item.size), 0);
        const capacityError = otherItems.length + 1 > MAX_COMPOSER_ATTACHMENTS
          || otherBytes + attachment.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes;
        const next = itemsRef.current.map((item) => item.key === key
          ? capacityError
            ? { ...item, status: 'failed' as const, error: COMPOSER_ATTACHMENT_LIMIT_MESSAGE }
            : { ...attachment, key, file: current.file, status: 'ready' as const }
          : item);
        itemsRef.current = next;
        setItems(next);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '附件读取失败');
        const next = itemsRef.current.map((item) => item.key === key
          ? { ...item, status: 'failed' as const, error: message }
          : item);
        itemsRef.current = next;
        setItems(next);
      }
    });
    return pending.current;
  }, []);
  const setStatus = useCallback((keys: readonly string[], status: PendingComposerAttachmentStatus, error?: string): void => {
    const keySet = new Set(keys);
    const next = itemsRef.current.map((item) => keySet.has(item.key)
      ? { ...item, status, error }
      : item);
    itemsRef.current = next;
    setItems(next);
  }, []);
  const markUploaded = useCallback((uploads: readonly { key: string; attachmentId: string }[]): void => {
    const ids = new Map(uploads.map(({ key, attachmentId }) => [key, attachmentId]));
    const next = itemsRef.current.map((item) => {
      const attachmentId = ids.get(item.key);
      return attachmentId ? { ...item, attachmentId, status: 'uploaded' as const, error: undefined } : item;
    });
    itemsRef.current = next;
    setItems(next);
  }, []);
  const clear = useCallback((): void => {
    generation.current += 1;
    itemsRef.current = [];
    setItems([]);
  }, []);
  return { items, addFiles, remove, retry, setStatus, markUploaded, clear };
}

async function readPendingAttachment(file: File): Promise<PendingComposerAttachment> {
  const attachment = await readChatAttachment(file);
  return { key: createAttachmentKey(file), ...attachment, file, status: 'ready' };
}

function createAttachmentKey(file: File): string {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  return `${identity}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}
