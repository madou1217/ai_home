const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestSessionKey, extractRequestProjectMetadata } = require('../lib/server/session-key');

test('extractRequestSessionKey prefers explicit session headers', () => {
  const key = extractRequestSessionKey(
    { 'x-session-id': 'session-abc' },
    { previous_response_id: 'resp_x' }
  );
  assert.equal(key, 'session-abc');
});

test('extractRequestSessionKey falls back to previous_response_id', () => {
  const key = extractRequestSessionKey({}, { previous_response_id: 'resp_123' });
  assert.equal(key, 'resp_123');
});

test('extractRequestSessionKey returns empty string when no session signal exists', () => {
  const key = extractRequestSessionKey({}, { model: 'gpt-dynamic', messages: [] });
  assert.equal(key, '');
});

test('extractRequestProjectMetadata extracts projectPath and projectDirName from headers and body', () => {
  const metaFromHeaders = extractRequestProjectMetadata(
    { 'x-project-path': '/Users/test/projects/my-repo', 'x-project-dir-name': 'my-repo' },
    {}
  );
  assert.equal(metaFromHeaders.projectPath, '/Users/test/projects/my-repo');
  assert.equal(metaFromHeaders.projectDirName, 'my-repo');

  const metaFromBody = extractRequestProjectMetadata(
    {},
    { project_path: '/Users/test/projects/second-repo', project_dir_name: 'second-repo' }
  );
  assert.equal(metaFromBody.projectPath, '/Users/test/projects/second-repo');
  assert.equal(metaFromBody.projectDirName, 'second-repo');

  const metaEmpty = extractRequestProjectMetadata({}, {});
  assert.equal(metaEmpty.projectPath, '');
  assert.equal(metaEmpty.projectDirName, '');
});
