import { useCallback, useRef, useState } from 'react';
import { message } from 'antd';
import { CHAT_ATTACHMENT_LIMITS, buildPastedTextFile, readChatAttachment, type ChatDocumentAttachment } from './attachment-files';

const ATTACHMENT_LIMIT_MESSAGE = `每次最多附加 ${CHAT_ATTACHMENT_LIMITS.maxFiles} 个文件，总大小不超过 ${Math.round(CHAT_ATTACHMENT_LIMITS.maxTotalBytes / 1048576)} MB`;

interface Options {
  images: string[];
  documents: ChatDocumentAttachment[];
  onImagesChange?: (images: string[]) => void;
  onDocumentsChange?: (documents: ChatDocumentAttachment[]) => void;
}

export interface ChatFileInputHandler {
  (files: readonly File[]): Promise<void>;
  addPastedText: (text: string) => Promise<void>;
  readonly pending: readonly PendingChatAttachment[];
  readonly retryPending: (key: string) => Promise<void>;
  readonly removePending: (key: string) => void;
}

export type PendingChatAttachmentStatus = 'preparing' | 'failed';

export interface PendingChatAttachment {
  readonly key: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly file: File;
  readonly status: PendingChatAttachmentStatus;
  readonly error?: string;
}

export function useChatFileInput(options: Options): ChatFileInputHandler {
  const latest = useRef(options);
  latest.current = options;
  const queue = useRef(Promise.resolve());
  const [pendingItems, setPendingItems] = useState<readonly PendingChatAttachment[]>([]);
  const pendingItemsRef = useRef(pendingItems);
  pendingItemsRef.current = pendingItems;
  const addFiles = useCallback((files: readonly File[]): Promise<void> => {
    const current = latest.current;
    const available = Math.max(0, CHAT_ATTACHMENT_LIMITS.maxFiles
      - current.images.length - current.documents.length - pendingItemsRef.current.length);
    if (files.length > available) message.warning(ATTACHMENT_LIMIT_MESSAGE);
    const entries = files.slice(0, available).map((file) => ({
      key: createPendingKey(file),
      name: file.name || '附件',
      mimeType: file.type || 'text/plain',
      size: file.size,
      file,
      status: 'preparing' as const,
    }));
    if (entries.length > 0) {
      const next = [...pendingItemsRef.current, ...entries];
      pendingItemsRef.current = next;
      setPendingItems(next);
    }
    // Serialize batches so simultaneous drops/selects cannot overwrite each other.
    queue.current = queue.current.then(async () => {
      const results = await Promise.allSettled(entries.map((entry) => readChatAttachment(entry.file)));
      const current = latest.current;
      const images = current.images.slice();
      const documents = current.documents.slice();
      let bytes = images.reduce((total, url) => total + Math.ceil((url.split(',')[1]?.length || 0) * 3 / 4), 0)
        + documents.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0);
      for (const [index, result] of results.entries()) {
        const entry = entries[index];
        if (!pendingItemsRef.current.some((item) => item.key === entry.key)) continue;
        if (result.status === 'rejected') {
          const error = String(result.reason?.message || '附件读取失败');
          updatePending(setPendingItems, pendingItemsRef, entry.key, { status: 'failed', error });
          message.warning(error);
          continue;
        }
        const attachment = result.value;
        if (images.length + documents.length >= CHAT_ATTACHMENT_LIMITS.maxFiles
            || bytes + attachment.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
          updatePending(setPendingItems, pendingItemsRef, entry.key, {
            status: 'failed', error: ATTACHMENT_LIMIT_MESSAGE,
          });
          message.warning(ATTACHMENT_LIMIT_MESSAGE);
          continue;
        }
        bytes += attachment.size;
        if (attachment.document) documents.push(attachment.document);
        else images.push(attachment.dataUrl);
        removePendingItem(setPendingItems, pendingItemsRef, entry.key);
      }
      latest.current = { ...current, images, documents };
      current.onImagesChange?.(images);
      current.onDocumentsChange?.(documents);
    }).catch(() => { message.error('附件读取失败'); });
    return queue.current;
  }, []);
  const retryPending = useCallback((key: string): Promise<void> => {
    const current = pendingItemsRef.current.find((item) => item.key === key);
    if (!current) return Promise.resolve();
    updatePending(setPendingItems, pendingItemsRef, key, { status: 'preparing', error: undefined });
    queue.current = queue.current.then(async () => {
      try {
        const attachment = await readChatAttachment(current.file);
        if (!pendingItemsRef.current.some((item) => item.key === key)) return;
        const latestOptions = latest.current;
        const images = latestOptions.images.slice();
        const documents = latestOptions.documents.slice();
        const bytes = images.reduce((total, url) => total + Math.ceil((url.split(',')[1]?.length || 0) * 3 / 4), 0)
          + documents.reduce((total, item) => total + new TextEncoder().encode(item.text).length, 0);
        if (images.length + documents.length >= CHAT_ATTACHMENT_LIMITS.maxFiles
            || bytes + attachment.size > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
          updatePending(setPendingItems, pendingItemsRef, key, {
            status: 'failed', error: ATTACHMENT_LIMIT_MESSAGE,
          });
          return;
        }
        if (attachment.document) documents.push(attachment.document);
        else images.push(attachment.dataUrl);
        latest.current = { ...latestOptions, images, documents };
        latestOptions.onImagesChange?.(images);
        latestOptions.onDocumentsChange?.(documents);
        removePendingItem(setPendingItems, pendingItemsRef, key);
      } catch (error) {
        updatePending(setPendingItems, pendingItemsRef, key, {
          status: 'failed', error: String(error instanceof Error ? error.message : error || '附件读取失败'),
        });
      }
    });
    return queue.current;
  }, []);
  const removePending = useCallback((key: string): void => {
    removePendingItem(setPendingItems, pendingItemsRef, key);
  }, []);
  return Object.assign(addFiles, {
    addPastedText: (text: string) => addFiles([buildPastedTextFile(text)]),
    pending: pendingItems,
    retryPending,
    removePending,
  });
}

function createPendingKey(file: File): string {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  return `${identity}:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function updatePending(
  setItems: (items: readonly PendingChatAttachment[]) => void,
  itemsRef: { current: readonly PendingChatAttachment[] },
  key: string,
  patch: Pick<PendingChatAttachment, 'status' | 'error'>,
): void {
  const next = itemsRef.current.map((item) => item.key === key ? { ...item, ...patch } : item);
  itemsRef.current = next;
  setItems(next);
}

function removePendingItem(
  setItems: (items: readonly PendingChatAttachment[]) => void,
  itemsRef: { current: readonly PendingChatAttachment[] },
  key: string,
): void {
  const next = itemsRef.current.filter((item) => item.key !== key);
  itemsRef.current = next;
  setItems(next);
}
