'use strict';

const { ChatRuntimeError } = require('./contracts');

function createUnsupportedArtifactReader() {
  return Object.freeze({
    async read() {
      throw new ChatRuntimeError('chat_artifact_unsupported', 501);
    }
  });
}

module.exports = { createUnsupportedArtifactReader };
