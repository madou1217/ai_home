'use strict';

// Browser-OAuth login differs per CLI provider: Codex exchanges the code itself,
// Antigravity and Claude paste the code back into a running CLI, and the rest
// forward a callback URL to a local loopback server. Instead of scattering
// `if (provider === 'x')` branches across the job manager, every provider
// implements this small contract and the manager dispatches polymorphically.
//
// Each provider strategy has been modularized into lib/server/oauth-strategies/.
// This file re-exports the registry and strategies for backward compatibility.

module.exports = require('./oauth-strategies');
