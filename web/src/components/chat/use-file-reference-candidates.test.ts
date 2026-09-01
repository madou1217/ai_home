import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fileTreeEntriesToCandidates,
  filterFileReferenceCandidates,
  type FileReferenceCandidate,
} from './use-file-reference-candidates';
import type { FileTreeEntry } from '@/services/api';

function entry(name: string, type: 'directory' | 'file' = 'file'): FileTreeEntry {
  return { name, type, mtime: 0, hasChildren: type === 'directory' };
}

test('fileTreeEntriesToCandidates 平铺转换并拼接父路径', () => {
  const candidates = fileTreeEntriesToCandidates(
    [entry('src', 'directory'), entry('README.md')],
    '',
  );
  assert.deepEqual(candidates, [
    { name: 'src', path: 'src', type: 'folder' },
    { name: 'README.md', path: 'README.md', type: 'file' },
  ]);

  const nested = fileTreeEntriesToCandidates([entry('App.tsx')], 'src');
  assert.deepEqual(nested, [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file' }]);
});

test('fileTreeEntriesToCandidates 剔除隐藏项与构建产物目录', () => {
  const candidates = fileTreeEntriesToCandidates([
    entry('.git', 'directory'),
    entry('.env'),
    entry('node_modules', 'directory'),
    entry('dist', 'directory'),
    entry('src', 'directory'),
  ]);
  assert.deepEqual(candidates.map((c) => c.name), ['src']);
});

test('filterFileReferenceCandidates 空 query 返回前 12 条', () => {
  const candidates: FileReferenceCandidate[] = Array.from({ length: 20 }, (_, i) => ({
    name: `f${i}.ts`,
    path: `src/f${i}.ts`,
    type: 'file',
  }));
  const filtered = filterFileReferenceCandidates(candidates, '');
  assert.equal(filtered.length, 12);
  assert.equal(filtered[0].name, 'f0.ts');
});

test('filterFileReferenceCandidates 按 name/path 大小写不敏感过滤', () => {
  const candidates: FileReferenceCandidate[] = [
    { name: 'App.tsx', path: 'src/App.tsx', type: 'file' },
    { name: 'server.ts', path: 'lib/server.ts', type: 'file' },
    { name: 'chat.module.css', path: 'src/chat.module.css', type: 'file' },
  ];
  assert.deepEqual(
    filterFileReferenceCandidates(candidates, 'APP').map((c) => c.path),
    ['src/App.tsx'],
  );
  assert.deepEqual(
    filterFileReferenceCandidates(candidates, 'lib/').map((c) => c.path),
    ['lib/server.ts'],
  );
  assert.deepEqual(filterFileReferenceCandidates(candidates, '不存在'), []);
});
