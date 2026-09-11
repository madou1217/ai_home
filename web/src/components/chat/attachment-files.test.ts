import { test, expect } from 'bun:test';
import {
  appendDocumentText,
  assertChatAttachmentSize,
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_LIMITS,
  resolveChatAttachmentKind,
} from './attachment-files';
import { createQueuedMessage, toRunInput } from '@/features/legacy-chat/legacy-runtime-policy';
import { resolveLegacyComposerSubmission } from '@/features/legacy-chat/legacy-composer-submission-policy.js';
import type { Account, Session } from '@/types';

test('Markdown is selectable even when the OS reports no MIME type', () => {
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.md');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.json');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('text/*');
});

test('videos are selectable via MIME type and via extension fallback', () => {
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('video/mp4');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.mp4');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.webm');
  expect(resolveChatAttachmentKind('clip.mp4', 'video/mp4')).toBe('video');
  expect(resolveChatAttachmentKind('clip.mov', '')).toBe('video');
  expect(resolveChatAttachmentKind('clip.mp4', 'application/octet-stream')).toBe('video');
  expect(resolveChatAttachmentKind('shot.png', 'image/png')).toBe('image');
  expect(resolveChatAttachmentKind('test.html', 'text/html')).toBe('document');
  expect(resolveChatAttachmentKind('archive.zip', 'application/zip')).toBe('');
});

test('documents larger than the old 1 MB ceiling pass while real oversize still fails', () => {
  expect(() => assertChatAttachmentSize('test.html', 'document', 1468006)).not.toThrow();
  expect(() => assertChatAttachmentSize('huge.md', 'document', CHAT_ATTACHMENT_LIMITS.maxDocumentBytes + 1))
    .toThrow('文本文件不能超过 16 MB');
  expect(() => assertChatAttachmentSize('large.mp4', 'video', 104857600)).not.toThrow();
  expect(() => assertChatAttachmentSize('large.mp4', 'video', 104857601)).toThrow('视频不能超过 100 MB');
  expect(() => assertChatAttachmentSize('a.png', 'image', CHAT_ATTACHMENT_LIMITS.maxImageBytes + 1))
    .toThrow('图片不能超过 10 MB');
  expect(() => assertChatAttachmentSize('empty.mp4', 'video', 0)).toThrow('视频为空');
});

test('document-only submissions preserve files through queue and run selection', () => {
  const account = { accountRef: 'account-1', provider: 'codex' } as Account;
  const session = { id: 'session-1', provider: 'codex', projectPath: '/repo' } as Session;
  const documents = [{ name: '需求.md', mimeType: 'text/markdown', text: '# 中文\n正文' }];
  const submission = resolveLegacyComposerSubmission({ account, session, documents, content: '' });
  expect(submission.ok).toBe(true);
  const queued = createQueuedMessage(account, 'gpt-5', submission.content, [], documents);
  const run = toRunInput(session, account, queued);
  expect(run.documents).toEqual(documents);
  expect(run.imageList).toEqual([]);
  expect(appendDocumentText(run.content, run.documents)).toContain('# 中文\n正文');
  expect(appendDocumentText(run.content, run.documents)).toContain('需求.md');
});
