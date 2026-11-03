'use strict';

const crypto = require('node:crypto');

function createNativeInteractionId(input = {}) {
  const provider = requiredIdentityPart(input.provider);
  const tuple = [
    provider,
    requiredIdentityPart(input.sessionId),
    requiredIdentityPart(input.nativeThreadId),
    requiredIdentityPart(input.nativeRequestId)
  ];
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(tuple))
    .digest('hex');
  return `interaction-${provider}-${digest}`;
}

function requiredIdentityPart(value) {
  const normalized = value === undefined || value === null
    ? ''
    : String(value).trim();
  if (normalized) return normalized;
  const error = new Error('native_interaction_identity_incomplete');
  error.code = 'native_interaction_identity_incomplete';
  throw error;
}

module.exports = { createNativeInteractionId };
