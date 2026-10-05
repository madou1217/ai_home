const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPolicy() {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'features',
    'legacy-chat',
    'legacy-composer-submission-policy.js'
  )).href);
}

function fixture(overrides = {}) {
  return {
    content: ' hello ',
    images: ['image-a'],
    model: 'claude-sonnet',
    account: { accountRef: 'account-1', provider: 'claude' },
    session: {
      id: 'session-1',
      provider: 'claude',
      projectPath: '/repo',
    },
    ...overrides,
  };
}

test('legacy composer validates every rejection before accepting draft cleanup', async () => {
  const { resolveLegacyComposerSubmission } = await loadPolicy();

  assert.deepEqual(resolveLegacyComposerSubmission(fixture({ content: ' ', images: [] })), {
    ok: false,
    reason: 'empty_content',
  });
  assert.deepEqual(resolveLegacyComposerSubmission(fixture({ account: null })), {
    ok: false,
    reason: 'account_required',
  });
  assert.deepEqual(resolveLegacyComposerSubmission(fixture({
    account: { accountRef: 'account-1', provider: 'codex' },
  })), {
    ok: false,
    reason: 'provider_mismatch',
    expectedProvider: 'claude',
  });
  assert.deepEqual(resolveLegacyComposerSubmission(fixture({
    session: { id: 'session-1', provider: 'claude', projectPath: '' },
  })), {
    ok: false,
    reason: 'project_path_required',
  });
});

test('legacy composer submission snapshots normalized content and attachments', async () => {
  const { resolveLegacyComposerSubmission } = await loadPolicy();
  const input = fixture();
  const result = resolveLegacyComposerSubmission(input);

  assert.deepEqual(result, {
    ok: true,
    account: input.account,
    session: input.session,
    model: 'claude-sonnet',
    content: 'hello',
    imageList: ['image-a'],
    projectPath: '/repo',
  });
  input.images.push('image-b');
  assert.deepEqual(result.imageList, ['image-a']);
});

test('legacy composer allows chat mode session without projectPath', async () => {
  const { resolveLegacyComposerSubmission } = await loadPolicy();
  const input = fixture({
    session: { id: 'chat-session-1', provider: 'claude', projectPath: '', mode: 'chat' },
  });
  const result = resolveLegacyComposerSubmission(input);

  assert.deepEqual(result, {
    ok: true,
    account: input.account,
    session: input.session,
    model: 'claude-sonnet',
    content: 'hello',
    imageList: ['image-a'],
    projectPath: '',
    mode: 'chat',
  });
});

test('shared native history resumes with the chosen same-region account and keeps its identity', async () => {
  const { resolveLegacyComposerSubmission } = await loadPolicy();
  for (const [provider, accountProvider] of [
    ['codebuddycn', 'workbuddycn'], ['workbuddycn', 'codebuddycn'],
    ['codebuddy', 'workbuddy'], ['workbuddy', 'codebuddy'],
  ]) {
    const input = fixture({
      account: { accountRef: 'real-execution-account', provider: accountProvider },
      session: { id: 'native-id', provider, projectPath: '/repo', projectDirName: 'repo' },
    });
    const result = resolveLegacyComposerSubmission(input);
    assert.equal(result.ok, true);
    assert.equal(result.account, input.account);
    assert.equal(result.session, input.session);
    assert.equal(result.session.id, 'native-id');
    assert.equal(result.session.provider, provider);
  }
});

test('shared native composer rejects cross-region and canonical account substitutions', async () => {
  const { resolveLegacyComposerSubmission } = await loadPolicy();
  const input = fixture({
    account: { accountRef: 'execution-account', provider: 'workbuddycn' },
    session: { id: 'native-id', provider: 'codebuddycn', projectPath: '/repo' },
  });
  for (const overrides of [
    { provider: 'codebuddy' }, { mode: 'chat' },
    { accountRef: 'session-owner' }, { runtimeSessionId: 'canonical-id' },
  ]) {
    const result = resolveLegacyComposerSubmission({
      ...input, session: { ...input.session, ...overrides },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'provider_mismatch');
  }
});
