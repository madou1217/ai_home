'use strict';

// Nine fractional USD digits are well below one token at current catalog prices,
// while removing IEEE-754 noise introduced by different parallel reduction orders.
const MODEL_USAGE_COST_DECIMALS = 9;

function normalizeModelUsageCostUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(MODEL_USAGE_COST_DECIMALS));
}

module.exports = {
  MODEL_USAGE_COST_DECIMALS,
  normalizeModelUsageCostUsd
};
