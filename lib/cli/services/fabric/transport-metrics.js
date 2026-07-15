'use strict';

function summarizeRtt(samples) {
  const values = samples.map((item) => Number(item.rttMs)).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length === 0) return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  const sum = values.reduce((acc, value) => acc + value, 0);
  const percentile = (rank) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))];
  return {
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    avg: Math.round((sum / values.length) * 100) / 100,
    p50: percentile(0.50),
    p95: percentile(0.95)
  };
}

module.exports = {
  summarizeRtt
};
