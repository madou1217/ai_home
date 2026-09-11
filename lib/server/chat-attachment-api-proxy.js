'use strict';

const { guessAttachmentMimeType } = require('./chat-attachments');
const { ATTACHMENT_KINDS } = require('./chat-attachment-validation');

function buildApiProxyAttachmentImages(materialized, fsImpl) {
  const items = Array.isArray(materialized) ? materialized : [];
  const originalImages = items
    .filter((item) => item && item.attachment && item.attachment.kind === ATTACHMENT_KINDS.IMAGE)
    .map((item) => item.attachment.dataUrl)
    .filter(Boolean);
  const videoFrames = items
    .filter((item) => item && item.attachment && item.attachment.kind === ATTACHMENT_KINDS.VIDEO)
    .flatMap((item) => Array.isArray(item.prepared && item.prepared.frames) ? item.prepared.frames : [])
    .map((frame) => (
      `data:${guessAttachmentMimeType(frame)};base64,${fsImpl.readFileSync(frame).toString('base64')}`
    ));
  return [...originalImages, ...videoFrames];
}

module.exports = { buildApiProxyAttachmentImages };
