'use strict';

function hasRoutingWarnings(result) {
  return (result?.warnings || []).some((warning) => String(warning).startsWith('routing_'));
}

function isCoreResultFullyApplied(result) {
  return Boolean(result?.ok && result.applied === true && !hasRoutingWarnings(result));
}

function normalizeCoreApplyResult(result) {
  const applied = isCoreResultFullyApplied(result);
  return {
    ...result,
    applied,
    ...(applied || result?.error || !hasRoutingWarnings(result)
      ? {}
      : { error: 'routing_not_fully_applied' })
  };
}

function mergeWarnings(...groups) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : []).filter(Boolean))];
}

module.exports = {
  hasRoutingWarnings,
  isCoreResultFullyApplied,
  mergeWarnings,
  normalizeCoreApplyResult
};
