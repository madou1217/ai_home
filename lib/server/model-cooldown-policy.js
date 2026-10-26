'use strict';

const { isQuotaFailure } = require('../account/quota-runtime-recovery');

// A real upstream capacity/rate refusal is a backoff instruction, not a local
// transport hiccup. Neither affinity nor the all-cooled fallback may bypass it.
const STRICT_MODEL_COOLDOWN_KINDS = new Set([
  'rate_limited', 'model_capacity_unavailable', 'model_overloaded', 'overloaded',
  'model_entitlement_required', 'account_tier_model_denied',
  'model_not_available_on_endpoint', 'model_region_restricted'
]);

function requiresModelCooldown(failure) {
  return isQuotaFailure(failure) || STRICT_MODEL_COOLDOWN_KINDS.has(failure?.kind);
}

module.exports = { requiresModelCooldown };
