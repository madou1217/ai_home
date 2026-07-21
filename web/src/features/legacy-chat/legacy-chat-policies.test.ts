import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Account,
  AggregatedProject,
  ChatMessage,
  InteractivePrompt,
  Session,
} from '@/types';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import { makeAihServerAccount } from '@/components/chat/aih-server-account';
import {
  isChatSelectableAccount,
  pickChatAccount,
} from './account-selection-policy';
import { humanizeChatError } from './chat-error-policy';
import { buildDirectoryBreadcrumbs } from './directory-path-policy';
import {
  dedupeChatMessages,
  isPureSessionHistoryAppend,
} from './message-history-policy';
import {
  buildDisplayProjects,
  findProjectBySessionId,
  normalizeProjectCatalog,
  resolveSessionProjectDirName,
  sortProjectsByLastActivityDesc,
} from './project-selection-policy';
import {
  createQueuedMessage,
  isApprovalPrompt,
  normalizePromptChoice,
  resolveDetachedRunId,
  resolveQueueTargetKey,
  toRunInput,
} from './legacy-runtime-policy';

function account(overrides: Partial<Account> = {}): Account {
  return {
    provider: 'codex', accountRef: 'account-1', status: 'up', displayName: 'Codex',
    configured: true, apiKeyMode: false, remainingPct: null, updatedAt: 1,
    planType: 'plus', email: 'user@example.com', ...overrides,
  };
}

function session(id: string, updatedAt: number): Session {
  return { id, updatedAt, title: id, provider: 'codex', projectPath: '/repo' };
}

function project(id: string, sessions: Session[]): AggregatedProject {
  return { id, name: id, path: `/${id}`, providers: ['codex'], sessions };
}

test('chat error policy prefers safe backend messages and maps stable codes', () => {
  assert.equal(humanizeChatError({ response: { data: {
    error: 'upstream_error', message: '账号暂不可用',
  } } }, '发送失败'), '账号暂不可用');
  assert.match(humanizeChatError(new Error('model_required'), '发送失败'), /选择一个模型/);
  assert.equal(humanizeChatError(new Error('{"detail":"稍后重试"}'), '发送失败'), '稍后重试');
});

test('account policy keeps the current provider and filters unavailable accounts', () => {
  const codex = account();
  const claude = account({ provider: 'claude', accountRef: 'account-2' });
  assert.equal(pickChatAccount(codex, [codex, claude], 'claude'), claude);
  assert.equal(isChatSelectableAccount(codex), true);
  assert.equal(isChatSelectableAccount({ ...codex, runtimeStatus: 'cooldown' }), false);
});

test('account policy selects a canonical session owner before another account of its provider', () => {
  const first = account({ accountRef: 'account-first' });
  const owner = account({ accountRef: 'account-owner' });

  assert.equal(
    pickChatAccount(first, [first, owner], 'codex', 'account-owner'),
    owner,
  );
  assert.equal(
    pickChatAccount(first, [first], 'codex', 'account-owner'),
    null,
  );
});

test('message history policy merges only adjacent duplicate user messages', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: ' hello ', images: ['a.png', 'a.png'], timestamp: 1_000 },
    { role: 'user', content: 'hello', images: ['a.png'], timestamp: 2_000 },
    { role: 'assistant', content: 'done' },
  ];
  assert.deepEqual(dedupeChatMessages(messages), [
    { role: 'user', content: 'hello', images: ['a.png'], timestamp: 2_000 },
    { role: 'assistant', content: 'done', images: [] },
  ]);
});

test('message history policy recognizes only an unchanged prefix as a pure append', () => {
  const previous: ChatMessage[] = [
    { role: 'user', content: ' hello ', timestamp: 1 },
    { role: 'assistant', content: 'working', timestamp: 2 },
  ];

  assert.equal(isPureSessionHistoryAppend(previous, [
    { role: 'user', content: 'hello', timestamp: 1 },
    { role: 'assistant', content: 'working', timestamp: 2 },
    { role: 'assistant', content: 'done', timestamp: 3 },
  ]), true);
  assert.equal(isPureSessionHistoryAppend(previous, [
    { role: 'user', content: 'hello', timestamp: 1 },
    { role: 'assistant', content: 'changed', timestamp: 2 },
    { role: 'assistant', content: 'done', timestamp: 3 },
  ]), false);
  assert.equal(isPureSessionHistoryAppend(previous, previous), false);
});

test('project policy owns native lookup, provider path adaptation, and activity ordering', () => {
  const older = project('older', [session('thread-1', 10)]);
  const newer = project('newer', [session('thread-2', 20)]);
  assert.deepEqual(sortProjectsByLastActivityDesc([older, newer]), [newer, older]);
  assert.equal(findProjectBySessionId([older, newer], {
    sessionId: 'thread-2', provider: 'codex',
  })?.project.id, 'newer');
  assert.equal(resolveSessionProjectDirName('claude', '/Users/me/repo'), '-Users-me-repo');
  assert.equal(resolveSessionProjectDirName('codex', '/Users/me/repo'), undefined);
});

test('project catalog policy filters invalid roots and projects a selected draft exactly once', () => {
  const saved = project('saved', [session('thread-1', 10)]);
  const hidden = {
    ...project('hidden', []), name: '默认项目', path: '默认项目',
  };
  assert.deepEqual(normalizeProjectCatalog([hidden, saved]), [saved]);

  const draftProject = project('draft-project', []);
  const draft = {
    ...session('draft-1', 20), projectPath: draftProject.path, draft: true,
  };
  const display = buildDisplayProjects([saved], draftProject, draft);
  assert.deepEqual(display.map(({ id }) => id), ['draft-project', 'saved']);
  assert.deepEqual(display[0].sessions.map(({ id }) => id), ['draft-1']);
});

test('directory path policy builds stable POSIX and Windows navigation targets', () => {
  assert.deepEqual(buildDirectoryBreadcrumbs('/Users/me/repo').map(({ label, path, current }) => ({
    label, path, current,
  })), [
    { label: '[Root]', path: '/', current: false },
    { label: 'Users', path: '/Users', current: false },
    { label: 'me', path: '/Users/me', current: false },
    { label: 'repo', path: '/Users/me/repo', current: true },
  ]);
  const windows = buildDirectoryBreadcrumbs('C:\\work\\repo');
  assert.equal(windows[windows.length - 1]?.path, 'C:\\work\\repo');
});

test('legacy runtime policy validates prompt choices and detached run ownership', () => {
  const savedSession = session('thread-runtime', 1);
  const sessionKey = getSessionRunKey(savedSession);
  const detachedRun = { sessionKey, runId: 'run-detached' };

  assert.equal(normalizePromptChoice(' 2 '), '2');
  assert.equal(normalizePromptChoice('0'), null);
  assert.equal(normalizePromptChoice('allow'), null);
  assert.equal(resolveDetachedRunId(savedSession, detachedRun), 'run-detached');
  assert.equal(resolveDetachedRunId({ ...savedSession, id: 'other' }, detachedRun), '');
  assert.equal(resolveDetachedRunId({ ...savedSession, draft: true }, detachedRun), '');
  assert.equal(resolveQueueTargetKey(savedSession, 'run-active', detachedRun), 'run-active');
  assert.equal(resolveQueueTargetKey(savedSession, '', detachedRun), sessionKey);

  const approval = {
    promptId: 'prompt-1',
    kind: 'approval',
    approvalId: 'approval-1',
  } as unknown as InteractivePrompt;
  assert.equal(isApprovalPrompt(approval), true);
  assert.equal(isApprovalPrompt({ promptId: 'prompt-2' } as InteractivePrompt), false);
});

test('legacy runtime queue factory preserves account ownership and gateway routing', () => {
  const savedSession = session('thread-queue', 1);
  const directAccount = account();
  const direct = createQueuedMessage(directAccount, 'gpt-5', 'hello', ['image']);
  assert.equal(direct.accountRef, directAccount.accountRef);
  assert.equal(direct.gateway, undefined);
  assert.equal(direct.mode, 'after_tool_call');
  assert.deepEqual(toRunInput(savedSession, directAccount, direct), {
    session: savedSession,
    account: directAccount,
    model: 'gpt-5',
    content: 'hello',
    imageList: ['image'],
  });

  const gateway = createQueuedMessage(makeAihServerAccount('claude'), '', 'next', []);
  assert.equal(gateway.gateway, true);
  assert.equal(gateway.accountRef, undefined);
  assert.equal(gateway.model, undefined);
  assert.equal(gateway.mode, 'after_turn');
});
