'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { digestWebDist } = require('../scripts/deploy-server');

function makeDist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-digest-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return dir;
}

function digestWith(records, compare) {
  const sorted = [...records].sort(compare);
  const input = sorted.map((item) => `${item.rel}\u0000${item.bytes}\u0000${item.sha}\n`).join('');
  return crypto.createHash('sha256').update(input).digest('hex');
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('web 工件摘要按码元排序：localeCompare 会算出另一个值，远端校验必然失败', () => {
  const dir = makeDist({
    'translation-extension/README.md': 'readme',
    'translation-extension/ai-home-logo.png': 'logo'
  });
  const records = [
    { rel: 'translation-extension/README.md', bytes: 6, sha: sha('readme') },
    { rel: 'translation-extension/ai-home-logo.png', bytes: 4, sha: sha('logo') }
  ];
  const byCodeUnit = digestWith(records, (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const byLocale = digestWith(records, (a, b) => a.rel.localeCompare(b.rel));
  assert.notStrictEqual(byCodeUnit, byLocale, '这一对文件名在两种排序下必须不同，否则测不出回归');
  assert.strictEqual(digestWebDist(dir).artifact_sha256, byCodeUnit, '摘要必须与远端的默认 sort 一致');
  assert.strictEqual(digestWebDist(dir).file_count, 2);
});

test('摘要稳定：与文件创建顺序、所在目录都无关', () => {
  const first = makeDist({ 'b.js': 'b', 'a.js': 'a', 'dir/c.js': 'c' });
  const second = makeDist({ 'dir/c.js': 'c', 'a.js': 'a', 'b.js': 'b' });
  assert.strictEqual(digestWebDist(first).artifact_sha256, digestWebDist(second).artifact_sha256);
});
