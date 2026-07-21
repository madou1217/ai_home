import { useCallback, useRef, useState } from 'react';
import { message as toast } from 'antd';
import type { ChatRuntimeAttachmentUpload } from '@/chat-runtime';

export const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
]);

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

  const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    const accepted = files.filter(isSupportedImage);
    if (accepted.length !== files.length) {
      toast.warning('仅支持 10 MB 以内的 PNG、JPEG、WebP 或 GIF 图片');
    }
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - itemsRef.current.length);
    if (accepted.length > available) toast.warning(`每次最多上传 ${MAX_COMPOSER_ATTACHMENTS} 张图片`);
    const selected = withinTotalSize(
      accepted.slice(0, available),
      itemsRef.current.reduce((total, item) => total + item.size, 0),
    );
    if (selected.length !== Math.min(accepted.length, available)) {
      toast.warning('待发送图片总大小不能超过 20 MB');
    }
    if (selected.length === 0) return;
    try {
      const additions = await Promise.all(selected.map(readPendingAttachment));
      const next = [...itemsRef.current, ...additions];
      itemsRef.current = next;
      setItems(next);
    } catch (_error) {
      toast.error('图片读取失败');
    }
  }, []);

  const remove = useCallback((key: string): void => {
    const next = itemsRef.current.filter((item) => item.key !== key);
    itemsRef.current = next;
    setItems(next);
  }, []);
  const clear = useCallback((): void => {
    itemsRef.current = [];
    setItems([]);
  }, []);
  return { items, addFiles, remove, clear };
}

function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type)
    && file.size > 0
    && file.size <= MAX_IMAGE_BYTES;
}

async function readPendingAttachment(file: File): Promise<PendingComposerAttachment> {
  return {
    key: createAttachmentKey(file),
    name: file.name || 'image',
    mimeType: file.type,
    size: file.size,
    dataUrl: await readDataUrl(file),
  };
}

function withinTotalSize(files: readonly File[], currentBytes: number): readonly File[] {
  let remaining = Math.max(0, MAX_TOTAL_IMAGE_BYTES - currentBytes);
  return files.filter((file) => {
    if (file.size > remaining) return false;
    remaining -= file.size;
    return true;
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('composer_attachment_read_failed'));
    reader.onerror = () => reject(reader.error || new Error('composer_attachment_read_failed'));
    reader.readAsDataURL(file);
  });
}

function createAttachmentKey(file: File): string {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  return `${identity}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}
