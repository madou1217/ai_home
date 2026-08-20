const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __private: modelUsageReadProjectionPrivate
} = require('../lib/usage/model-usage-read-projection');

function createCandidate(scannerId, proxyId, deltaMs = 0) {
  return {
    scannerId,
    proxyId,
    scannerTimestampMs: scannerId,
    deltaMs,
    sessionRank: 0
  };
}

test('observation matching partitions disconnected candidate graphs', () => {
  assert.equal(
    typeof modelUsageReadProjectionPrivate.partitionObservationCandidates,
    'function'
  );

  const components = modelUsageReadProjectionPrivate.partitionObservationCandidates([
    createCandidate(2, 11, 20),
    createCandidate(1, 10, 10),
    createCandidate(2, 10, 30),
    createCandidate(3, 12, 5)
  ]);

  assert.deepEqual(
    components.map((component) => (
      component.map(({ scannerId, proxyId }) => [scannerId, proxyId])
    )),
    [
      [[3, 12]],
      [[1, 10], [2, 11], [2, 10]]
    ]
  );
});

test('observation matching keeps large disconnected ranges inside the read budget', () => {
  const candidates = Array.from({ length: 12_000 }, (_, index) => (
    createCandidate(index + 1, index + 100_001, index % 1_000)
  ));
  const startedAt = performance.now();

  const matches = modelUsageReadProjectionPrivate.matchObservationCandidates(candidates);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(matches.length, candidates.length);
  assert.deepEqual(
    matches.map(({ scannerId, proxyId }) => [scannerId, proxyId]),
    candidates
      .slice()
      .sort((left, right) => (
        left.deltaMs - right.deltaMs || left.scannerTimestampMs - right.scannerTimestampMs
      ))
      .map(({ scannerId, proxyId }) => [scannerId, proxyId])
  );
  assert.ok(elapsedMs < 2_000, `disconnected matching took ${Math.round(elapsedMs)}ms`);
});
