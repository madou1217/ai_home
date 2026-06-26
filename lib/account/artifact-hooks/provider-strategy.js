'use strict';

class AccountArtifactHookStrategy {
  constructor(options = {}) {
    this.provider = String(options.provider || '').trim().toLowerCase();
    this.authArtifactRelativePaths = Object.freeze((options.authArtifactRelativePaths || []).slice());
    this.configArtifactRelativePaths = Object.freeze((options.configArtifactRelativePaths || []).slice());
    this.onDefaultAccountAuthUpdated = options.onDefaultAccountAuthUpdated;
    this.onAccountConfigUpdated = options.onAccountConfigUpdated;
  }

  getAuthArtifactRelativePaths() {
    return this.authArtifactRelativePaths.slice();
  }

  getConfigArtifactRelativePaths() {
    return this.configArtifactRelativePaths.slice();
  }

  handleDefaultAccountAuthUpdated(event) {
    return this.invoke(this.onDefaultAccountAuthUpdated, event);
  }

  handleAccountConfigUpdated(event) {
    return this.invoke(this.onAccountConfigUpdated, event);
  }

  invoke(handler, event) {
    if (typeof handler !== 'function') {
      return { ok: true, dispatched: false, reason: 'no_handler', event };
    }
    handler(event);
    return { ok: true, dispatched: true, event };
  }
}

module.exports = {
  AccountArtifactHookStrategy
};
