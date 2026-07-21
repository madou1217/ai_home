'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ChatRuntimeAttachmentService
} = require('../lib/server/chat-runtime/attachment-service');

test('attachment service persists canonical image metadata against its session', () => {
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

  const attachments = service.upload('session-1', {
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

test('attachment service rejects unsupported payloads before filesystem writes', () => {
  let persisted = false;
  const service = new ChatRuntimeAttachmentService({
    store: {
      getSession: () => ({ sessionId: 'session-1', provider: 'codex', projectPath: '/repo' })
    },
    persistImages() { persisted = true; }
  });

  assert.throws(() => service.upload('session-1', {
    attachments: [{
      name: 'notes.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,YQ=='
    }]
  }), (error) => error.code === 'chat_attachment_mime_unsupported');
  assert.equal(persisted, false);
});
