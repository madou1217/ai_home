import assert from 'node:assert/strict';
import test from 'node:test';

import { proxyToolTargetsOf } from './use-proxy-diagnostics.ts';

test('uses the server plugin list when present', () => {
  const targets = proxyToolTargetsOf({
    ok: true,
    env: { httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '' },
    toolTargets: [{ id: 'pip', name: 'pip', scopeLabel: 'global.proxy' }],
    tools: {}
  });
  assert.deepEqual(targets.map((target) => target.id), ['pip']);
});

test('falls back to git/npm for older servers', () => {
  assert.deepEqual(proxyToolTargetsOf(null).map((target) => target.id), ['git', 'npm']);
});
