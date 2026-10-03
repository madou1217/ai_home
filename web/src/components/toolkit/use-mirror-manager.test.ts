import assert from 'node:assert/strict';
import test from 'node:test';

import { mirrorKindsOf, mirrorStatusOf } from './use-mirror-manager.ts';

test('uses the server plugin list when present', () => {
  const data = {
    ok: true,
    kinds: [{ id: 'cargo', name: 'cargo', label: 'Rust cargo', settingLabel: 'crates source' }],
    cargo: { current: 'https://rsproxy.cn', presets: [] }
  };
  assert.deepEqual(mirrorKindsOf(data).map((kind) => kind.id), ['cargo']);
  assert.equal(mirrorStatusOf(data, 'cargo')?.current, 'https://rsproxy.cn');
  assert.equal(mirrorStatusOf(data, 'kinds'), undefined);
});

test('falls back to npm/pip for older servers', () => {
  assert.deepEqual(mirrorKindsOf({ ok: true }).map((kind) => kind.id), ['npm', 'pip']);
});
