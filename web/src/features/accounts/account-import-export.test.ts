import assert from 'node:assert/strict';
import test from 'node:test';

import type { AccountImportJob } from '@/types';
import {
  EXPORT_ACTIONS,
  PASTE_TEMPLATES,
  buildImportResponseFromJob,
  formatImportJobProgress,
  formatImportResult
} from './account-import-export.ts';

function makeImportJob(overrides: Partial<AccountImportJob> = {}): AccountImportJob {
  return {
    id: 'import-1',
    status: 'running',
    mode: 'upload',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

test('EXPORT_ACTIONS exposes the three supported export formats', () => {
  assert.deepEqual(
    EXPORT_ACTIONS.map((action) => action.format),
    ['antigravity', 'cliproxyapi']
  );
  EXPORT_ACTIONS.forEach((action) => {
    assert.ok(action.label.length > 0);
    assert.ok(action.description.length > 0);
  });
});

test('PASTE_TEMPLATES covers every template kind with parseable JSON', () => {
  assert.deepEqual(Object.keys(PASTE_TEMPLATES).sort(), ['antigravity', 'jsonl']);
  for (const template of Object.values(PASTE_TEMPLATES)) {
    assert.ok(template.label.length > 0);
    assert.ok(template.description.length > 0);
    assert.ok(template.value.length > 0);
  }
});

test('formatImportResult summarizes counts from the summary block', () => {
  assert.equal(
    formatImportResult({
      ok: true,
      imported: 5,
      summary: {
        imported: 5,
        created: 2,
        updated: 1,
        skipped: 1,
        invalid: 0,
        failed: 1,
        total: 5,
        providers: [],
        accounts: []
      }
    }),
    '导入完成：写入 5，新增 2，更新 1，跳过 1，失败 1'
  );
  // 无 summary 时退化为写入总数文案
  assert.equal(formatImportResult({ ok: true, imported: 3 }), '导入完成，写入 3 个账号');
  // 全 0 摘要只保留写入数
  assert.equal(
    formatImportResult({
      ok: true,
      imported: 0,
      summary: {
        imported: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        invalid: 0,
        failed: 0,
        total: 0,
        providers: [],
        accounts: []
      }
    }),
    '导入完成：写入 0'
  );
});

test('buildImportResponseFromJob projects job state into an import response', () => {
  const response = buildImportResponseFromJob(makeImportJob({
    status: 'succeeded',
    summary: {
      imported: 4,
      created: 4,
      updated: 0,
      skipped: 0,
      invalid: 0,
      failed: 0,
      total: 4,
      providers: [],
      accounts: []
    },
    result: { note: 'done' }
  }));
  assert.equal(response.ok, true);
  assert.equal(response.imported, 4);
  assert.deepEqual(response.result, { note: 'done' });
});

test('formatImportJobProgress renders percent with optional label', () => {
  assert.equal(formatImportJobProgress(null), '');
  assert.equal(formatImportJobProgress(makeImportJob({ status: 'queued' })), '等待后台导入开始');
  assert.equal(formatImportJobProgress(makeImportJob({ status: 'running' })), '后台导入中');
  assert.equal(
    formatImportJobProgress(makeImportJob({
      status: 'running',
      progress: { current: 2, total: 10, percent: 20, label: '写入账号' }
    })),
    '20% · 写入账号'
  );
  assert.equal(
    formatImportJobProgress(makeImportJob({
      status: 'running',
      progress: { current: 2, total: 10, percent: 20 }
    })),
    '20%'
  );
});
test('readImportUploadFiles encodes every file as base64 and keeps folder paths', async () => {
  const { readImportUploadFiles, describeImportSelection } = await import('./account-import-export.ts');
  const encoder = new TextEncoder();
  const makeFile = (name: string, text: string, webkitRelativePath = '') => ({
    name,
    webkitRelativePath,
    arrayBuffer: async () => encoder.encode(text).buffer as ArrayBuffer
  });
  const uploads = await readImportUploadFiles([makeFile('a.json', '{"x":1}', 'dir/a.json')]);
  assert.deepEqual(uploads, [{
    name: 'a.json',
    relativePath: 'dir/a.json',
    contentBase64: Buffer.from('{"x":1}').toString('base64'),
    encoding: 'base64'
  }]);
  assert.equal(describeImportSelection([makeFile('a.json', '')], 'file'), 'a.json');
  assert.equal(describeImportSelection([makeFile('a.json', ''), makeFile('b.zip', '')], 'file'), 'a.json 等 2 个文件');
  assert.equal(describeImportSelection([makeFile('a.json', '', 'dump/a.json'), makeFile('b.json', '', 'dump/b.json')], 'folder'), 'dump（2 个文件）');
});
