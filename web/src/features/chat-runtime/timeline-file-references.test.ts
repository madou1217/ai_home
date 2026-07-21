import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTimelineFileReferences } from './timeline-file-references';

test('collects canonical file change and tool paths without treating command output as a file', () => {
  assert.deepEqual(collectTimelineFileReferences({
    kind: 'file_change',
    detail: {
      changes: [
        { path: '/repo/src/app.ts', kind: 'update' },
        { filePath: './README.md', kind: 'update' },
      ],
    },
  }), ['/repo/src/app.ts', './README.md']);

  assert.deepEqual(collectTimelineFileReferences({
    kind: 'tool',
    detail: {
      input: { path: '/repo/output/report.html' },
      result: 'completed successfully',
    },
  }), ['/repo/output/report.html']);
});

test('deduplicates paths and rejects URLs, prose, and private object fields', () => {
  assert.deepEqual(collectTimelineFileReferences({
    kind: 'tool',
    detail: {
      input: {
        path: '/repo/result.png',
        nested: { file_path: '/repo/result.png' },
        url: 'https://example.com/result.png',
        prompt: 'please inspect /repo/secret.txt',
      },
    },
  }), ['/repo/result.png']);
});
