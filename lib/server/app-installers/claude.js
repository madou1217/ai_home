'use strict';

const { createProviderInstaller } = require('./provider-factory');

module.exports = createProviderInstaller({
  provider: 'claude',
  desktop: {
    darwin: { cask: 'claude' },
    win32: { wingetId: 'Anthropic.Claude' }
  }
});
