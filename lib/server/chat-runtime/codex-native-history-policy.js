'use strict';

// Raw notification media is needed for lossless partial-turn forks. Codex's
// opt-in omission feature otherwise removes images/audio before AIH sees them.
function nativeHistoryParams(params) {
  return { ...params, config: { ...params.config, 'features.omit_app_server_notification_media': false } };
}

module.exports = { nativeHistoryParams };
