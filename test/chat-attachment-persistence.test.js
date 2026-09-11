'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { persistChatDocuments } = require('../lib/server/chat-document-attachments');
const { persistChatImages } = require('../lib/server/chat-attachments');
const { persistChatVideos } = require('../lib/server/chat-video-attachments');
const { materializeChatAttachments } = require('../lib/server/chat-attachment-persistence');
const { normalizeLegacyChatAttachments } = require('../lib/server/chat-attachment-validation');

function failureInjectingFs(root, failAt) {
  let writes = 0;
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'writeFileSync') {
        return (filePath, ...args) => {
          writes += 1;
          if (writes === failAt) {
            target.writeFileSync(filePath, Buffer.from('partial'));
            throw new Error('injected_write_failure');
          }
          return target.writeFileSync(filePath, ...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function assertDirectoryHasNoEntries(root) {
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
}

test('image, document and video writers publish complete batches or no files', (t) => {
  for (const fixture of [
    {
      name: 'images',
      run(fsImpl, hostHomeDir) {
        return persistChatImages([
          'data:image/png;base64,YQ==',
          'data:image/png;base64,Yg=='
        ], { fs: fsImpl, provider: 'codex', hostHomeDir });
      }
    },
    {
      name: 'documents',
      run(fsImpl, hostHomeDir) {
        return persistChatDocuments([
          { name: 'a.md', mimeType: 'text/markdown', text: 'a' },
          { name: 'b.md', mimeType: 'text/markdown', text: 'b' }
        ], { fs: fsImpl, provider: 'codex', hostHomeDir });
      }
    },
    {
      name: 'videos',
      run(fsImpl, hostHomeDir) {
        return persistChatVideos([
          { name: 'a.mp4', mimeType: 'video/mp4', dataUrl: 'data:video/mp4;base64,YQ==' },
          { name: 'b.mp4', mimeType: 'video/mp4', dataUrl: 'data:video/mp4;base64,Yg==' }
        ], { fs: fsImpl, provider: 'codex', hostHomeDir });
      }
    }
  ]) {
    const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), `aih-${fixture.name}-atomic-`));
    t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
    const attachmentRoot = path.join(hostHomeDir, '.codex', 'attachments');
    assert.throws(() => fixture.run(failureInjectingFs(attachmentRoot, 2), hostHomeDir),
      /injected_write_failure/);
    assertDirectoryHasNoEntries(attachmentRoot);
  }
});

test('legacy mixed attachments roll back documents, images, videos and frame artifacts together', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-legacy-mixed-atomic-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const attachments = normalizeLegacyChatAttachments({
    documents: [{ name: 'notes.md', mimeType: 'text/markdown', text: '# legacy document' }],
    images: [
      'data:image/png;base64,YQ==',
      'data:video/mp4;base64,Yg=='
    ]
  });

  await assert.rejects(() => materializeChatAttachments(attachments, {
    fs,
    provider: 'codex',
    hostHomeDir,
    async prepareVideo(filePath) {
      fs.mkdirSync(`${filePath}.frames`, { recursive: true });
      fs.writeFileSync(path.join(`${filePath}.frames`, 'frame-01.jpg'), 'partial-frame');
      throw new Error('injected_legacy_video_failure');
    }
  }), /injected_legacy_video_failure/);

  assertDirectoryHasNoEntries(path.join(hostHomeDir, '.codex', 'attachments'));
});

test('materialized videos expose the original path to prompt assembly', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-legacy-video-context-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const [video] = await materializeChatAttachments(normalizeLegacyChatAttachments({
    images: ['data:video/mp4;base64,YQ==']
  }), {
    fs,
    provider: 'codex',
    hostHomeDir,
    async prepareVideo(filePath) {
      return { filePath, frames: [], metadata: { durationSeconds: 1 }, framesReady: false };
    }
  });

  assert.equal(video.prepared.path, video.filePath);
  assert.equal(video.prepared.filePath, video.filePath);
});
