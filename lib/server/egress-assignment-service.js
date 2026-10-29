'use strict';

// Account-first read model for egress assignments.
//
// The entity store is the durable shape that the migration is moving toward,
// while account:egress:* is still the compatibility source of truth for
// existing writes. Keep that boundary in one adapter so callers do not each
// invent their own projection/fallback rules.

const nodeFs = require('node:fs');

const {
  EGRESS_MODE_POOL,
  listAccountEgressBindings,
  readAccountEgressBinding
} = require('../account/zcode-egress-binding-store');
const { isAccountRef } = require('../account/public-account-ref');
const { normalizeAccountEgressAssignment } = require('./egress-domain-contract');

function normalizeRef(value) {
  return String(value || '').trim();
}

function assignmentFromLegacy(accountRef, binding) {
  if (!binding || binding.retired || binding.mode !== EGRESS_MODE_POOL) return null;
  return normalizeAccountEgressAssignment({
    accountRef,
    selectionMode: 'auto',
    strategy: binding.strategy,
    scope: binding.scope,
    updatedAt: binding.updatedAt
  });
}

function createEgressAssignmentService(options = {}) {
  const entityStore = options.entityStore || null;
  const fs = options.fs || nodeFs;
  const aiHomeDir = normalizeRef(options.aiHomeDir);
  const readLegacy = typeof options.readLegacyBinding === 'function'
    ? options.readLegacyBinding
    : readAccountEgressBinding;
  const listLegacy = typeof options.listLegacyBindings === 'function'
    ? options.listLegacyBindings
    : listAccountEgressBindings;

  function readLegacyState(accountRef) {
    if (!fs || !aiHomeDir) return { available: false, binding: null };
    // A malformed legacy record must remain fail-closed. Do not let a stale
    // projection bypass a record that the compatibility reader could not validate.
    const binding = readLegacy(fs, aiHomeDir, accountRef);
    return { available: true, binding };
  }

  function getAssignment(accountRef) {
    const ref = normalizeRef(accountRef);
    if (!isAccountRef(ref)) return null;
    const state = readLegacyState(ref);
    const projected = entityStore && typeof entityStore.getAssignment === 'function'
      ? entityStore.getAssignment(ref)
      : null;
    if (state.available && state.binding) {
      const legacyAssignment = assignmentFromLegacy(ref, state.binding);
      // Compatibility writes remain authoritative. A non-pool binding (or an
      // explicit unbind) suppresses an old projection. A pool record is
      // normalized directly so a failed mirror can never make the planner
      // observe stale account settings.
      if (legacyAssignment) return legacyAssignment;
      return null;
    }
    // A missing compatibility record means this account is either newly
    // migrated or its optional mirror was already removed. In both cases the
    // durable account-first projection is the only available assignment.
    return projected || null;
  }

  function listAssignments() {
    const projected = entityStore && typeof entityStore.listAssignments === 'function'
      ? entityStore.listAssignments()
      : [];
    if (!fs || !aiHomeDir) return projected;

    const result = new Map();
    projected.forEach((assignment) => {
      const ref = normalizeRef(assignment && assignment.accountRef);
      if (!isAccountRef(ref)) return;
      // Reuse getAssignment so an explicit legacy unbind cannot leave a stale
      // account in the account-first list.
      const current = getAssignment(ref);
      if (current) result.set(ref, current);
    });

    let legacyEntries = [];
    try {
      legacyEntries = listLegacy(fs, aiHomeDir);
    } catch (_error) {
      // A list failure must not erase the already loaded projection. The
      // account-specific read path remains strict and fail-closed.
      legacyEntries = [];
    }
    legacyEntries.forEach((entry) => {
      const ref = normalizeRef(entry && entry.accountRef);
      if (!isAccountRef(ref) || result.has(ref)) return;
      const assignment = assignmentFromLegacy(ref, entry.binding);
      if (assignment) result.set(ref, assignment);
    });
    return [...result.values()];
  }

  return { getAssignment, listAssignments };
}

module.exports = {
  assignmentFromLegacy,
  createEgressAssignmentService
};
