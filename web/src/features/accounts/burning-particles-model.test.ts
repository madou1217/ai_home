import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBurningSparkSpecs,
  clampBurningAnchor
} from './burning-particles-model.ts';

test('clampBurningAnchor preserves real endpoints and rejects invalid values', () => {
  assert.equal(clampBurningAnchor(-10), 0);
  assert.equal(clampBurningAnchor(0), 0);
  assert.equal(clampBurningAnchor(37.5), 37.5);
  assert.equal(clampBurningAnchor(100), 100);
  assert.equal(clampBurningAnchor(120), 100);
  assert.equal(clampBurningAnchor(Number.NaN), 0);
});

test('buildBurningSparkSpecs stays dense, short-lived and close to the fuse point', () => {
  const quiet = buildBurningSparkSpecs('#52c41a', 0);
  const busy = buildBurningSparkSpecs('#52c41a', 20);

  assert.equal(quiet.length, 32);
  assert.equal(busy.length, 48);
  assert.ok(busy.every((spark) => Math.hypot(spark.dx, spark.dy) <= 18.01));
  assert.ok(busy.every((spark) => spark.duration > 0 && spark.duration < 0.8));
  assert.ok(busy.every((spark) => spark.delay <= 0));
  assert.ok(busy.some((spark) => spark.ember));
  assert.ok(busy.some((spark) => !spark.ember));
  assert.ok(new Set(busy.map((spark) => Math.round(spark.hue))).size > 1);
});

test('buildBurningSparkSpecs has spatial dispersion and temporal jitter within one track', () => {
  const sparks = buildBurningSparkSpecs('#52c41a', 8, 'acct:gemini:5h');
  const uniqueDirections = new Set(sparks.map((spark) => Math.round(spark.rotation / 5)));
  const uniqueDistances = new Set(
    sparks.map((spark) => Math.round(Math.hypot(spark.dx, spark.dy)))
  );
  const uniqueDurations = new Set(sparks.map((spark) => spark.duration.toFixed(3)));
  const uniquePhases = new Set(sparks.map((spark) => spark.delay.toFixed(3)));

  assert.ok(uniqueDirections.size >= sparks.length * 0.65);
  assert.ok(uniqueDistances.size >= 8);
  assert.ok(uniqueDurations.size >= sparks.length * 0.55);
  assert.ok(uniquePhases.size >= sparks.length * 0.55);
  assert.ok(sparks.some((spark) => spark.dy < 0));
  assert.ok(sparks.some((spark) => spark.dy > 0));
});

test('buildBurningSparkSpecs is deterministic for stable animation tracks', () => {
  assert.deepEqual(
    buildBurningSparkSpecs('#ff4d4f', 6, 'acct:gemini:5h'),
    buildBurningSparkSpecs('#ff4d4f', 6, 'acct:gemini:5h')
  );
});

test('buildBurningSparkSpecs decorrelates different progress tracks', () => {
  const first = buildBurningSparkSpecs('#52c41a', 6, 'acct:gemini:5h');
  const second = buildBurningSparkSpecs('#52c41a', 6, 'acct:claude_gpt:weekly');

  const decorrelatedCount = first.filter((spark, index) => {
    const peer = second[index];
    return Math.hypot(spark.dx - peer.dx, spark.dy - peer.dy) > 1
      || Math.abs(spark.delay - peer.delay) > 0.01
      || Math.abs(spark.duration - peer.duration) > 0.01;
  }).length;

  assert.notDeepEqual(first, second);
  assert.ok(decorrelatedCount >= first.length * 0.8);
});
