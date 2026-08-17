'use strict';

const { createProviderInstaller } = require('./provider-factory');

module.exports = createProviderInstaller({
  provider: 'codex',
  desktop: {
    darwin: { cask: 'chatgpt' },
    win32: { wingetId: 'OpenAI.ChatGPT' }
  }
});
