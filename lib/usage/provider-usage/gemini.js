'use strict';

module.exports = Object.freeze({
  id: 'gemini',
  capability: 'provider.usage',
  accountSnapshotRefresh: true,
  ptyUsageStatus: true,
  liveAccountIdentity: ({ configured, cleanAccountName }) => (configured ? { email: cleanAccountName() } : null)
});
