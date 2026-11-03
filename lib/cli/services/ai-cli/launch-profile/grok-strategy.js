'use strict';

/**
 * Grok Build exposes GROK_HOME as its supported user-state override. Point it
 * at the account projection's .grok directory instead of relying on OS home
 * discovery, which differs between Windows-native and POSIX builds.
 */
function buildEnvPatch(ctx) {
  return {
    set: {
      GROK_HOME: ctx.path.join(ctx.sandboxDir, '.grok')
    },
    unset: []
  };
}

const grokStrategy = Object.freeze({
  name: 'grok-home',
  buildEnvPatch
});

module.exports = {
  grokStrategy,
  buildEnvPatch
};
