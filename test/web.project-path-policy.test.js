'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadProjectPathPolicy() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'project-path-policy.js'
  )).href;
  return import(modulePath);
}

test('project path policy accepts POSIX, Windows drive, and UNC absolute paths', async () => {
  const { isAbsoluteProjectPath } = await loadProjectPathPolicy();

  assert.equal(isAbsoluteProjectPath('/Users/model/projects/ai_home'), true);
  assert.equal(isAbsoluteProjectPath('C:\\Users\\model\\ai_home'), true);
  assert.equal(isAbsoluteProjectPath('D:/projects/ai_home'), true);
  assert.equal(isAbsoluteProjectPath('\\\\server\\share\\ai_home'), true);
});

test('project path policy rejects empty and relative paths', async () => {
  const { isAbsoluteProjectPath } = await loadProjectPathPolicy();

  assert.equal(isAbsoluteProjectPath(''), false);
  assert.equal(isAbsoluteProjectPath('projects/ai_home'), false);
  assert.equal(isAbsoluteProjectPath('默认项目'), false);
  assert.equal(isAbsoluteProjectPath('C:projects\\ai_home'), false);
});
