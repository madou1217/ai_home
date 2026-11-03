'use strict';

const { ChatRuntimeError } = require('./contracts');

class InteractionResolutionCoordinator {
  constructor(transitions, options = {}) {
    this.transitions = transitions;
    this.releaseFailureSink = typeof options.releaseFailureSink === 'function'
      ? options.releaseFailureSink
      : () => {};
  }

  async resolve(interactionId, input, effect) {
    if (typeof effect !== 'function') {
      throw new ChatRuntimeError('chat_interaction_effect_required', 500);
    }
    const claimed = this.transitions.claim(interactionId, input);
    let response;
    try {
      response = await effect(claimed);
    } catch (error) {
      this.releaseWithoutMaskingProviderError(claimed);
      throw error;
    }
    return {
      interaction: this.transitions.finish(claimed),
      response
    };
  }

  releaseWithoutMaskingProviderError(claimed) {
    try {
      this.transitions.release(claimed);
    } catch (releaseError) {
      this.reportReleaseFailure(releaseError, claimed);
    }
  }

  reportReleaseFailure(error, claimed) {
    try {
      this.releaseFailureSink(releaseFailureDiagnostic(error, claimed));
    } catch (_sinkError) {}
  }
}

function releaseFailureDiagnostic(_error, claimed = {}) {
  const diagnostic = {
    code: 'chat_interaction_release_failed',
    interactionId: String(claimed.interactionId || ''),
    revision: Number(claimed.revision)
  };
  const sessionId = String(claimed.sessionId || '');
  return sessionId ? { ...diagnostic, sessionId } : diagnostic;
}

module.exports = { InteractionResolutionCoordinator };
