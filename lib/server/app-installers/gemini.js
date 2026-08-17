'use strict';

const { createProviderInstaller } = require('./provider-factory');

module.exports = createProviderInstaller({
  provider: 'gemini',
  desktop: {
    darwin: { cask: 'gemini' },
    win32: { wingetId: 'Google.Gemini' }
  }
});
