'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ChatRuntimeAttachmentService
} = require('../lib/server/chat-runtime/attachment-service');

test('attachment service persists canonical image metadata against its session', async () => {
  const calls = [];
  const store = {
    getSession(sessionId) {
      return sessionId === 'session-1'
        ? { sessionId, provider: 'codex', projectPath: '/repo' }
        : null;
    },
    createAttachments(sessionId, attachments) {
      calls.push({ sessionId, attachments });
      return attachments.map((attachment, index) => ({
        attachmentId: `attachment-${index + 1}`,
        sessionId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        createdAt: 1
      }));
    }
  };
  const service = new ChatRuntimeAttachmentService({
    store,
    fs: {},
    aiHomeDir: '/aih',
    hostHomeDir: '/home',
    persistImages(images, options) {
      assert.deepEqual(images, ['data:image/png;base64,YQ==']);
      assert.deepEqual({
        provider: options.provider,
        aiHomeDir: options.aiHomeDir,
        hostHomeDir: options.hostHomeDir,
        projectPath: options.projectPath
      }, {
        provider: 'codex', aiHomeDir: '/aih', hostHomeDir: '/home', projectPath: '/repo'
      });
      return ['/home/.codex/attachments/shot.png'];
    }
  });

  const attachments = await service.upload('session-1', {
    attachments: [{
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ=='
    }]
  });

  assert.equal(attachments[0].attachmentId, 'attachment-1');
  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    attachments: [{
      filePath: '/home/.codex/attachments/shot.png',
      name: 'shot.png',
      mimeType: 'image/png'
    }]
  }]);
});

test('attachment service rejects unsupported payloads before filesystem writes', async () => {
  let persisted = false;
  const service = new ChatRuntimeAttachmentService({
    store: {
      getSession: () => ({ sessionId: 'session-1', provider: 'codex', projectPath: '/repo' })
    },
    persistImages() { persisted = true; }
  });

  await assert.rejects(() => service.upload('session-1', {
    attachments: [{
      name: 'archive.zip', mimeType: 'application/zip', dataUrl: 'data:application/zip;base64,YQ=='
    }]
  }), (error) => error.code === 'chat_attachment_mime_unsupported');
  assert.equal(persisted, false);
});

test('attachment service persists videos and prepares key frames before registering', async () => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-videos-'));
  const prepared = [];
  const service = new ChatRuntimeAttachmentService({
    fs, hostHomeDir,
    store: {
      getSession: () => ({ sessionId: 's1', provider: 'codex' }),
      createAttachments: (_sessionId, attachments) => attachments
    },
    async prepareVideo(filePath) {
      prepared.push(filePath);
      return { filePath, frames: [], metadata: {}, framesReady: false };
    }
  });

  const dataUrl = `data:video/mp4;base64,${Buffer.from('fake-mp4-payload').toString('base64')}`;
  const [attachment] = await service.upload('s1', { attachments: [{
    name: '演示.mp4', mimeType: 'video/mp4', dataUrl
  }] });

  assert.equal(attachment.mimeType, 'video/mp4');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0], attachment.filePath);
  assert.equal(fs.readFileSync(attachment.filePath).toString(), 'fake-mp4-payload');
  assert.ok(path.basename(attachment.filePath).endsWith('演示.mp4'));
  fs.rmSync(hostHomeDir, { recursive: true, force: true });
});

test('attachment service rejects oversized videos before persistence', async () => {
  const limits = require('../contracts/chat-attachments.json');
  const oversized = 'data:video/mp4;base64,' + 'A'.repeat(Math.ceil(limits.maxVideoBytes / 3) * 4 + 4);
  const service = new ChatRuntimeAttachmentService({
    fs: {},
    store: {
      getSession: () => ({ sessionId: 's1', provider: 'codex' }),
      createAttachments: (_sessionId, attachments) => attachments
    }
  });
  await assert.rejects(() => service.upload('s1', { attachments: [{
    name: 'big.mp4', mimeType: 'video/mp4', dataUrl: oversized
  }] }), /100 MB/);
});

test('attachment service rolls back a mixed batch when video preparation throws', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-attachment-rollback-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  let registered = false;
  const service = new ChatRuntimeAttachmentService({
    fs,
    hostHomeDir,
    store: {
      getSession: () => ({ sessionId: 's1', provider: 'codex' }),
      createAttachments() { registered = true; }
    },
    async prepareVideo(filePath) {
      fs.mkdirSync(`${filePath}.frames`, { recursive: true });
      fs.writeFileSync(path.join(`${filePath}.frames`, 'frame-01.jpg'), 'partial-frame');
      throw new Error('injected_video_prepare_failure');
    }
  });
  const dataUrl = (mimeType, value) => `data:${mimeType};base64,${Buffer.from(value).toString('base64')}`;

  await assert.rejects(() => service.upload('s1', { attachments: [
    { name: 'notes.md', mimeType: 'text/markdown', dataUrl: dataUrl('text/markdown', '# rollback') },
    { name: 'shot.png', mimeType: 'image/png', dataUrl: dataUrl('image/png', 'image') },
    { name: 'clip.mp4', mimeType: 'video/mp4', dataUrl: dataUrl('video/mp4', 'video') }
  ] }), /injected_video_prepare_failure/);

  const attachmentRoot = path.join(hostHomeDir, '.codex', 'attachments');
  assert.equal(registered, false);
  assert.deepEqual(fs.existsSync(attachmentRoot) ? fs.readdirSync(attachmentRoot) : [], []);
});

test('attachment service removes materialized files when DB registration fails', async (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-attachment-db-rollback-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const service = new ChatRuntimeAttachmentService({
    fs,
    hostHomeDir,
    store: {
      getSession: () => ({ sessionId: 's1', provider: 'codex' }),
      createAttachments() { throw new Error('injected_attachment_db_failure'); }
    }
  });

  await assert.rejects(() => service.upload('s1', { attachments: [{
    name: 'notes.txt',
    mimeType: 'text/plain',
    dataUrl: `data:text/plain;base64,${Buffer.from('persist then rollback').toString('base64')}`
  }] }), /injected_attachment_db_failure/);

  const attachmentRoot = path.join(hostHomeDir, '.codex', 'attachments');
  assert.deepEqual(fs.existsSync(attachmentRoot) ? fs.readdirSync(attachmentRoot) : [], []);
});
