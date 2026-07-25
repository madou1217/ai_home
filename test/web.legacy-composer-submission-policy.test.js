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

  assert.deepEqual(resolveLegacyComposerSubmission(fixture({ content: ' ' })), {
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
