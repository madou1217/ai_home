'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeChatDocuments, persistChatDocuments, documentFromUpload } = require('../lib/server/chat-document-attachments');
const { buildApiProxyMessages } = require('../lib/server/webui-chat-routes-opencode-proxy');
const { ChatRuntimeAttachmentService } = require('../lib/server/chat-runtime/attachment-service');
const { resolveProviderAttachmentRoot } = require('../lib/runtime/provider-storage-policy');

test('text documents keep Chinese names and UTF-8 content without escaping storage', (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-documents-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const text = '# 中文需求\n\n内容与代码 `a < b`';
  const documents = [{ name: '../../需求.md', mimeType: '', text }];
  const [file] = persistChatDocuments(documents, { fs, provider: 'codex', hostHomeDir });
  assert.ok(file.startsWith(resolveProviderAttachmentRoot(hostHomeDir, 'codex') + path.sep));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.ok(path.basename(file).endsWith('需求.md'));
  const [disguised] = persistChatDocuments([{ name: 'notes.png', mimeType: 'text/plain', text }], { fs, provider: 'codex', hostHomeDir });
  assert.ok(disguised.endsWith('.txt'));
});

test('pure chat forwards document content once as text alongside real images', () => {
  const messages = [{ role: 'user', content: '请读附件' }];
  const documents = [{ name: '方案.md', mimeType: 'text/markdown', text: '# Plan\nUNIQUE_DOC_MARKER' }];
  const result = buildApiProxyMessages(messages, ['data:image/png;base64,YQ=='], { documents });
  assert.equal(result[0].content[0].type, 'text');
  assert.equal(result[0].content[0].text.match(/UNIQUE_DOC_MARKER/g).length, 1);
  assert.match(result[0].content[0].text, /方案.md/);
  assert.equal(result[0].content[1].type, 'image_url');
  assert.deepEqual(messages, [{ role: 'user', content: '请读附件' }]);
});

test('runtime uploads store Markdown as a document with canonical metadata', (t) => {
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-documents-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const service = new ChatRuntimeAttachmentService({
    fs, hostHomeDir,
    store: {
      getSession: () => ({ sessionId: 's1', provider: 'codex' }),
      createAttachments: (_sessionId, attachments) => attachments
    }
  });
  const [attachment] = service.upload('s1', { attachments: [{
    name: 'empty.md', mimeType: 'text/markdown', dataUrl: 'data:text/markdown;base64,'
  }] });
  assert.equal(attachment.mimeType, 'text/markdown');
  assert.equal(fs.readFileSync(attachment.filePath, 'utf8'), '');
});

test('document validation rejects oversized, binary and malformed uploads before persistence', () => {
  assert.throws(() => normalizeChatDocuments([{ name: 'x.md', text: 'x'.repeat(1048577) }]), /1 MB/);
  assert.throws(() => normalizeChatDocuments([{ name: 'x.md', text: 'abc\0def' }]), /二进制/);
  assert.throws(() => normalizeChatDocuments([{ name: 'x.zip', mimeType: 'application/zip', text: 'zip' }]), /文本/);
  assert.throws(() => documentFromUpload({ name: 'x.md', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,/w==' }), /UTF-8/);
});
