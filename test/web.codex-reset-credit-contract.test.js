'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RESET_MODAL_PATH = path.join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'accounts',
  'CodexResetCreditsModal.tsx'
);

test('Codex reset modal keeps the compact two-column reset contract', () => {
  const source = fs.readFileSync(RESET_MODAL_PATH, 'utf8');
  const tableHead = source.match(/<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/);

  assert.ok(tableHead, 'reset-credit table header must exist');
  const headers = Array.from(
    tableHead[1].matchAll(/<th\b[^>]*>([^<]+)<\/th>/g),
    (match) => match[1].trim()
  );

  assert.deepEqual(headers, ['序号', '过期时间']);
  assert.match(source, /okText="重置"/);
  assert.match(source, />\s*重置\s*<\/Button>/);
  assert.doesNotMatch(source, /使用最早过期卡重置|获得时间|使用时间/);
});
