import { test, expect } from 'bun:test';
import { appendDocumentText, CHAT_ATTACHMENT_ACCEPT } from './attachment-files';
import { createQueuedMessage, toRunInput } from '@/features/legacy-chat/legacy-runtime-policy';
import { resolveLegacyComposerSubmission } from '@/features/legacy-chat/legacy-composer-submission-policy.js';
import type { Account, Session } from '@/types';

test('Markdown is selectable even when the OS reports no MIME type', () => {
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.md');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('.json');
  expect(CHAT_ATTACHMENT_ACCEPT.split(',')).toContain('text/*');
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
