'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_TREND_POINTS = 120;
const TREND_BUCKET_CANDIDATES = Object.freeze([
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  HOUR_MS,
  6 * HOUR_MS,
  DAY_MS,
  7 * DAY_MS,
  30 * DAY_MS
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function resolveModelUsageTrend(query = {}) {
  const fromMs = positiveInteger(query.fromMs || query.from);
  const toMs = Math.max(fromMs, positiveInteger(query.toMs || query.to) || fromMs);
  const requestedBucketMs = positiveInteger(query.trendBucketMs || query.bucketMs);
  const requestedOriginMs = positiveInteger(query.trendOriginMs || query.originMs);
  if (requestedBucketMs && requestedOriginMs) {
    return {
      fromMs,
      toMs,
      originMs: requestedOriginMs,
      bucketMs: requestedBucketMs
    };
  }

  const spanMs = Math.max(1, toMs - fromMs + 1);
  const bucketMs = TREND_BUCKET_CANDIDATES.find((candidate) => (
    Math.ceil(spanMs / candidate) <= MAX_TREND_POINTS
  )) || Math.ceil(spanMs / MAX_TREND_POINTS);
  return { fromMs, toMs, originMs: fromMs, bucketMs };
}

function listModelUsageTrendBucketStarts(query = {}) {
  const trend = resolveModelUsageTrend(query);
  if (!trend.originMs || !trend.bucketMs || trend.toMs < trend.fromMs) return [];
  const firstIndex = Math.max(0, Math.floor((trend.fromMs - trend.originMs) / trend.bucketMs));
  const lastIndex = Math.max(firstIndex, Math.floor((trend.toMs - trend.originMs) / trend.bucketMs));
  return Array.from({ length: lastIndex - firstIndex + 1 }, (_unused, offset) => (
    trend.originMs + (firstIndex + offset) * trend.bucketMs
  ));
}

module.exports = {
  DAY_MS,
  MAX_TREND_POINTS,
  TREND_BUCKET_CANDIDATES,
  listModelUsageTrendBucketStarts,
  resolveModelUsageTrend
};
